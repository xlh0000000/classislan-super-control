<script setup lang="ts">
import { configKindEntry } from "#shared/configuration-kinds";

// 类型页：/configurations/components、/automation、/plugin；课表直接跳它的专页。
const kind = String(useRoute().params.kind ?? "");
const entry = configKindEntry(kind);
if (!entry) throw createError({ statusCode: 404, statusMessage: "没有这种配置类型。", fatal: true });
if (entry.id === "profile") await navigateTo(entry.page, { replace: true });
</script>

<template>
  <ConfigurationLibrary v-if="entry.id !== 'profile'" :kind="entry.id" />
</template>
