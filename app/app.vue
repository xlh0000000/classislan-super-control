<script setup lang="ts">
useHead({
  htmlAttrs: { lang: "zh-CN" },
  titleTemplate: (title) =>
    title ? `${title} · ClassIsland Control` : "ClassIsland Control",
  meta: [
    { name: "description", content: "ClassIsland 公开能力的集中管理控制平面" },
    { name: "theme-color", content: "#ffffff" },
  ],
});
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <ToastHost />
</template>