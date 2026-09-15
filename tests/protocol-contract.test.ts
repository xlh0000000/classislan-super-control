import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { enrollSchema, pollSchema } from "../shared/schemas";

type ContractVector = { name: string; schema: "enroll" | "poll"; json: string };
type ContractFile = { version: string; vectors: ContractVector[] };

const contract = JSON.parse(
  readFileSync(new URL("../shared/protocol-vectors.json", import.meta.url), "utf8"),
) as ContractFile;

const schemas = { enroll: enrollSchema, poll: pollSchema } as const;

describe("C#→TS 协议字节契约（由 tools/ProtocolVectors 生成）", () => {
  it("携带版本化的非空向量集", () => {
    expect(contract.version).toBe("protocol-v1");
    expect(contract.vectors.length).toBeGreaterThan(0);
    for (const vector of contract.vectors) expect(Object.keys(schemas)).toContain(vector.schema);
  });

  for (const vector of contract.vectors) {
    it(`服务端 schema 接受 C# 实际字节：${vector.name}`, () => {
      const body = JSON.parse(vector.json) as unknown;
      const result = schemas[vector.schema].safeParse(body);
      expect(result.success, result.success ? "" : JSON.stringify(result.error.issues)).toBe(true);
    });
  }

  it("C# 对可空字段省略键而不是写 null（Zod .optional() 只接受缺省）", () => {
    const enroll = JSON.parse(contract.vectors.find((v) => v.schema === "enroll")!.json) as Record<string, unknown>;
    expect("keyThumbprint" in enroll).toBe(false);

    const nullFields = JSON.parse(contract.vectors.find((v) => v.name === "poll-request-null-capabilities-and-acks")!.json) as Record<string, unknown>;
    expect("capabilities" in nullFields).toBe(false);
    expect("appliedSections" in nullFields).toBe(false);
  });

  it("ACK 结果为 null 时省略 result 键，有结果时保留对象", () => {
    const poll = JSON.parse(contract.vectors.find((v) => v.name === "poll-request-with-ack-results")!.json) as {
      acknowledgements: Record<string, unknown>[];
    };
    expect("result" in poll.acknowledgements[0]).toBe(false);
    expect(poll.acknowledgements[1].result).toEqual({ error: "policy-conflict", attempt: 2 });
  });
});