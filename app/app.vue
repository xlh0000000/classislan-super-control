<script setup lang="ts">
useHead({
  htmlAttrs: { lang: "zh-CN" },
  titleTemplate: (title) =>
    title ? `${title} · Classisland Super Control` : "Classisland Super Control",
  meta: [
    { name: "description", content: "ClassIsland 公开能力的集中管理控制平面" },
    { name: "theme-color", content: "#ffffff" },
  ],
  link: [
    { rel: "icon", type: "image/svg+xml", href: "/brand/favicon.svg" },
    { rel: "apple-touch-icon", href: "/brand/apple-touch-icon.png" },
  ],
});
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <ToastHost />
</template>