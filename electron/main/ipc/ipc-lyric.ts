import { ipcMain, screen } from "electron";
import lyricWindow from "../windows/lyric-window";
import { useStore } from "../store";
import mainWindow from "../windows/main-window";
import { isAbsolute, relative, resolve } from "path";

/**
 * 歌词相关 IPC
 */
const initLyricIpc = (): void => {
  const store = useStore();
  const mainWin = mainWindow.getWin();
  const lyricWin = lyricWindow.getWin();

  // 切换桌面歌词
  ipcMain.on("change-desktop-lyric", (_event, val: boolean) => {
    if (val) {
      lyricWin?.show();
      lyricWin?.setAlwaysOnTop(true, "screen-saver");
    } else lyricWin?.hide();
  });

  // 音乐名称更改
  ipcMain.on("play-song-change", (_, title) => {
    if (!title) return;
    lyricWin?.webContents.send("play-song-change", title);
  });

  // 音乐歌词更改
  ipcMain.on("play-lyric-change", (_, lyricData) => {
    if (!lyricData) return;
    lyricWin?.webContents.send("play-lyric-change", lyricData);
  });

  // 获取窗口位置
  ipcMain.handle("get-window-bounds", () => {
    return lyricWin?.getBounds();
  });

  // 获取屏幕尺寸
  ipcMain.handle("get-screen-size", () => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    return { width, height };
  });

  // 移动窗口
  ipcMain.on("move-window", (_, x, y, width, height) => {
    lyricWin?.setBounds({ x, y, width, height });
    // 保存配置
    store.set("lyric", { ...store.get("lyric"), x, y, width, height });
    // 保持置顶
    lyricWin?.setAlwaysOnTop(true, "screen-saver");
  });

  // 更新高度
  ipcMain.on("update-window-height", (_, height) => {
    if (!lyricWin) return;
    const { width } = lyricWin.getBounds();
    // 更新窗口高度
    lyricWin.setBounds({ width, height });
  });

  // 获取配置
  ipcMain.handle("get-desktop-lyric-option", () => {
    return store.get("lyric");
  });

  // 保存配置
  ipcMain.on("set-desktop-lyric-option", (_, option, callback: boolean = false) => {
    store.set("lyric", option);
    // 触发窗口更新
    if (callback && lyricWin) {
      lyricWin.webContents.send("desktop-lyric-option-change", option);
    }
    mainWin?.webContents.send("desktop-lyric-option-change", option);
  });

  // 发送主程序事件
  ipcMain.on("send-main-event", (_, name, val) => {
    mainWin?.webContents.send(name, val);
  });

  // 关闭桌面歌词
  ipcMain.on("closeDesktopLyric", () => {
    lyricWin?.hide();
    mainWin?.webContents.send("closeDesktopLyric");
  });

  // 锁定/解锁桌面歌词
  ipcMain.on("toogleDesktopLyricLock", (_, isLock: boolean) => {
    if (!lyricWin) return;
    // 是否穿透
    if (isLock) {
      lyricWin.setIgnoreMouseEvents(true, { forward: true });
    } else {
      lyricWin.setIgnoreMouseEvents(false);
    }
  });

  // 检查是否是子文件夹
  ipcMain.handle("check-if-subfolder", (_, localFilesPath: string[], selectedDir: string) => {
    const resolvedSelectedDir = resolve(selectedDir);
    const allPaths = localFilesPath.map((p) => resolve(p));
    return allPaths.some((existingPath) => {
      const relativePath = relative(existingPath, resolvedSelectedDir);
      return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath);
    });
  });
};

export default initLyricIpc;
