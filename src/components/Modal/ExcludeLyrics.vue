<template>
  <div class="exclude">
    <n-alert :show-icon="false">请勿添加过多，以免影响歌词的正常显示</n-alert>

    <n-tabs type="line" v-model:value="page" animated>
      <n-tab-pane name="keywords" tab="关键词">
        <n-dynamic-tags v-model:value="settingStore.excludeKeywords" />
      </n-tab-pane>
      <n-tab-pane name="regexes" tab="正则表达式">
        <n-dynamic-tags v-model:value="settingStore.excludeRegexes" />
      </n-tab-pane>

      <template #suffix>
        <n-button type="primary" strong secondary @click="reset">重置此页</n-button>
      </template>
    </n-tabs>
  </div>
</template>

<script setup lang="ts">
import { useSettingStore } from "@/stores";
import { keywords, regexes } from "@/assets/data/exclude";

const settingStore = useSettingStore();

const page = ref("keywords");

const reset = () => {
  switch (page.value) {
    case "keywords":
      settingStore.excludeKeywords = keywords;
      break;
    case "regexes":
      settingStore.excludeRegexes = regexes;
      break;
  }
};
</script>

<style lang="scss" scoped>
.exclude {
  .n-alert {
    margin-bottom: 20px;
  }
}
</style>
