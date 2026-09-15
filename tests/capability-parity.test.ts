import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 设备上报的 CapabilityCatalog 决定服务端是否允许为该设备创建任务；
 * HostOperationService 的 switch 决定设备能否真正执行。两者一旦不一致，
 * 就会“创建成功但执行返回 unsupported”，因此用静态一致性测试守住这个契约。
 */
const catalogSource = readFileSync(
  new URL("../plugin/ClassIsland.Control.Plugin/Services/CapabilityCatalog.cs", import.meta.url),
  "utf8",
);
const executorSource = readFileSync(
  new URL("../plugin/ClassIsland.Control.Plugin/Services/HostOperationService.cs", import.meta.url),
  "utf8",
);

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

/** `new("id", ...)` 与 `AddIf<T>("id", ...)` 两种声明方式。 */
function catalogIds(source: string): string[] {
  return [...matches(source, /new\("([a-z0-9._-]+\.v\d+)"/g), ...matches(source, /AddIf<[^>]+>\("([a-z0-9._-]+\.v\d+)"/g)];
}

/** switch 分支形如 `"id" => ...`。 */
function executorIds(source: string): string[] {
  return matches(source, /"([a-z0-9._-]+\.v\d+)"\s*=>/g);
}

describe("能力目录 ↔ 执行器一致性", () => {
  const catalog = new Set(catalogIds(catalogSource));
  const executor = new Set(executorIds(executorSource));

  it("仍然声明核心能力（防止正则失效后测试形同虚设）", () => {
    for (const id of ["app.lifecycle.v1", "profile.readwrite.persist.v1", "lessons.state.read.v1", "automation.workflow.persist.v1", "notification.own-provider.send.v1"])
      expect(catalog, `缺少核心能力 ${id}`).toContain(id);
    expect(executor.size).toBeGreaterThanOrEqual(catalog.size);
  });

  it("每个对外声明（并会被服务端用于校验）的能力都有执行分支", () => {
    const missing = [...catalog].filter((id) => !executor.has(id)).sort();
    expect(missing, `以下能力已声明但没有执行分支：${missing.join(", ")}`).toEqual([]);
  });

  it("不存在没有对外声明的执行分支（避免设备执行服务端认为不存在的能力）", () => {
    const extra = [...executor].filter((id) => !catalog.has(id)).sort();
    expect(extra, `以下执行分支没有对应声明：${extra.join(", ")}`).toEqual([]);
  });
});