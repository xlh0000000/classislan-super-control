<script setup lang="ts">
import { configKindEntry } from "#shared/configuration-kinds";

// 类型列表页：/configurations/profile、/components、/automation、/plugin。
const kind = String(useRoute().params.kind ?? "");
const entry = configKindEntry(kind);
if (!entry) throw createError({ statusCode: 404, statusMessage: "没有这种配置类型。", fatal: true });
</script>

<template>
  <ConfigurationLibrary :kind="entry.id" />
</template>
