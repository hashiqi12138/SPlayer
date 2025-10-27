<template>
  <div ref="desktopLyricsRef" class="desktop-lyrics">
    {{ lyricData.playName }}
    {{ lyricConfig }}
  </div>
</template>

<script setup lang="ts">
import type { LyricType } from "@/types/main";

// 桌面歌词数据
const lyricData = reactive<{
  playName: string;
  playStatus: boolean;
  progress: number;
  lrcData: LyricType[];
  yrcData: LyricType[];
  lyricIndex: number;
}>({
  playName: "未知歌曲",
  playStatus: false,
  progress: 0,
  lrcData: [],
  yrcData: [],
  lyricIndex: -1,
});

// 桌面歌词配置
const lyricConfig = reactive<{
  fontSize: number;
  lineHeight: number;
}>({
  fontSize: 24,
  lineHeight: 48,
});
</script>

<style scoped lang="scss">
.desktop-lyrics {
  color: #fff;
  background-color: transparent;
}
</style>
