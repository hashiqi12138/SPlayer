import { app, ipcMain } from "electron";
import { useStore } from "../store";
import { isDev } from "../utils/config";
import { initThumbar } from "../thumbar";
import mainWindow from "../windows/main-window";
import loadWindow from "../windows/load-window";
import loginWindow from "../windows/login-window";

/**
 * 窗口 IPC 通信
 * @returns void
 */
const initWindowsIpc = (): void => {
  // 相关窗口
  const mainWin = mainWindow.getWin();
  const loadWin = loadWindow.getWin();
  // store
  const store = useStore();

  // 当前窗口状态
  ipcMain.on("win-state", (event) => {
    event.returnValue = mainWin?.isMaximized();
  });

  // 加载完成
  ipcMain.on("win-loaded", () => {
    if (loadWin && !loadWin.isDestroyed()) loadWin.destroy();
    const isMaximized = store.get("window")?.maximized;
    if (isMaximized) mainWin?.maximize();
    mainWin?.show();
    mainWin?.focus();
    // 初始化缩略图工具栏
    if (mainWin) initThumbar(mainWin);
  });

  // 最小化
  ipcMain.on("win-min", (event) => {
    event.preventDefault();
    mainWin?.minimize();
  });

  // 最大化
  ipcMain.on("win-max", () => {
    mainWin?.maximize();
  });

  // 还原
  ipcMain.on("win-restore", () => {
    mainWin?.restore();
  });

  // 关闭
  ipcMain.on("win-close", (event) => {
    event.preventDefault();
    mainWin?.close();
    app.quit();
  });

  // 隐藏
  ipcMain.on("win-hide", () => {
    mainWin?.hide();
  });

  // 显示
  ipcMain.on("win-show", () => {
    mainWin?.show();
  });

  // 重启
  ipcMain.on("win-reload", () => {
    app.quit();
    app.relaunch();
  });

  // 显示进度
  ipcMain.on("set-bar", (_event, val: number | "none" | "indeterminate" | "error" | "paused") => {
    switch (val) {
      case "none":
        mainWin?.setProgressBar(-1);
        break;
      case "indeterminate":
        mainWin?.setProgressBar(2, { mode: "indeterminate" });
        break;
      case "error":
        mainWin?.setProgressBar(1, { mode: "error" });
        break;
      case "paused":
        mainWin?.setProgressBar(1, { mode: "paused" });
        break;
      default:
        if (typeof val === "number") {
          mainWin?.setProgressBar(val / 100);
        } else {
          mainWin?.setProgressBar(-1);
        }
        break;
    }
  });

  // 开启控制台
  ipcMain.on("open-dev-tools", () => {
    mainWin?.webContents.openDevTools({
      title: "SPlayer DevTools",
      mode: isDev ? "right" : "detach",
    });
  });

  // 开启登录窗口
  ipcMain.on("open-login-web", () => loginWindow.create(mainWin!));
};

export default initWindowsIpc;
