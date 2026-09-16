import { z } from "zod";
import { adoptTimetableAsConfiguration } from "../../../../../utils/device-timetable";
import { assertDeviceInScope } from "../../../../../utils/scope";

// 贡献者：威廉（采纳设备课表档案为配置库 profile 配置）
// 功能：把设备上报的本地课表快照写入配置库，作为一条 kind="profile" 的配置（新建或追加修订），
// 之后可经策略引用 { "$config": id } 下发给其他设备——即"把一台机器的课表变成全校可用的配置"。

const adoptSchema = z.object({
  configurationId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100).optional(),
});

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "configurations.write");
  assertSchoolWideScope(user, "配置库");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  assertDeviceInScope(db, user, id);

  const body = await readBody(event).catch(() => ({}));
  const parsed = adoptSchema.safeParse(body);
  if (!parsed.success) throw createError({ statusCode: 400, message: "参数无效。" });
  return adoptTimetableAsConfiguration(db, user, id, parsed.data);
});
