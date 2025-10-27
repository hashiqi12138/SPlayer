import { screen } from "electron";
import { storeLog } from "../logger";
import Store from "electron-store";

storeLog.info("🌱 Store init");

export interface StoreType {
  window: {
    width: number;
    height: number;
    x?: number;
    y?: number;
    maximized?: boolean;
  };
  lyric: {
    fontSize: number;
    mainColor: string;
    shadowColor: string;
    // 窗口位置
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  proxy: string;
}

/**
 * 使用 Store
 * @returns Store<StoreType>
 */
export const useStore = () => {
  return new Store<StoreType>({
    defaults: {
      window: {
        width: 1280,
        height: 800,
      },
      lyric: {
        fontSize: 30,
        mainColor: "#fff",
        shadowColor: "rgba(0, 0, 0, 0.5)",
        x: screen.getPrimaryDisplay().workAreaSize.width / 2 - 400,
        y: screen.getPrimaryDisplay().workAreaSize.height - 90,
        width: 800,
        height: 180,
      },
      proxy: "",
    },
  });
};
