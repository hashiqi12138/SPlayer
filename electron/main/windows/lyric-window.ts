import { BrowserWindow } from "electron";
import { createWindow } from "./index";
import { useStore } from "../store";
import { join } from "path";

class LyricWindow {
  private win: BrowserWindow | null = null;
  constructor() {}
  /**
   * 主窗口事件
   * @returns void
   */
  private event(): void {
    if (!this.win) return;
    // 歌词窗口缩放
    this.win?.on("resized", () => {
      const store = useStore();
      const bounds = this.win?.getBounds();
      if (bounds) {
        const { width, height } = bounds;
        store.set("lyric", { ...store.get("lyric"), width, height });
      }
    });
  }
  /**
   * 创建主窗口
   * @returns BrowserWindow | null
   */
  create(): BrowserWindow | null {
    const store = useStore();
    const { width, height, x, y } = store.get("lyric");
    this.win = createWindow({
      width: width || 800,
      height: height || 180,
      minWidth: 440,
      minHeight: 120,
      maxWidth: 1600,
      maxHeight: 300,
      // 窗口位置
      x,
      y,
      transparent: true,
      backgroundColor: "rgba(0, 0, 0, 0)",
      alwaysOnTop: true,
      resizable: true,
      movable: true,
      show: false,
      // 不在任务栏显示
      skipTaskbar: true,
      // 窗口不能最小化
      minimizable: false,
      // 窗口不能最大化
      maximizable: false,
      // 窗口不能进入全屏状态
      fullscreenable: false,
    });
    if (!this.win) return null;
    // 加载地址
    this.win.loadFile(join(__dirname, "../main/web/lyric.html"));
    // 窗口事件
    this.event();
    return this.win;
  }
  /**
   * 获取窗口
   * @returns BrowserWindow | null
   */
  getWin(): BrowserWindow | null {
    return this.win;
  }
}

export default new LyricWindow();
