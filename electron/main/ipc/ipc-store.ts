import { useStore } from "../store";

/**
 * 初始化 store IPC 主进程
 */
const initStoreIpc = (): void => {
  const store = useStore();
  if (!store) return;
};

export default initStoreIpc;
