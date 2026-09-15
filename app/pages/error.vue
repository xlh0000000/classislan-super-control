<script setup lang="ts">
const route = useRoute();
const error = (route.query.error as string) || "请求的页面不存在或暂不可用。";
</script>

<template>
  <PageHeading kicker="RECOVERY / 恢复" title="无法打开页面" :description="error" />
  <EmptyState title="操作没有完成" description="返回总览检查控制平面状态，或稍后重试。" action="返回总览" to="/" />
</template>
