import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { basename, join, resolve } from "path";
import { access, readFile, stat, unlink, writeFile } from "fs/promises";
import { parseFile } from "music-metadata";
import { getFileID, getFileMD5, metaDataLyricsArrayToLrc } from "../utils/helper";
import { File, Picture, Id3v2Settings } from "node-taglib-sharp";
import { ipcLog } from "../logger";
import FastGlob from "fast-glob";
import { download } from "electron-dl";

/**
 * 文件相关 IPC
 */
const initFileIpc = (): void => {
  // 默认文件夹
  ipcMain.handle(
    "get-default-dir",
    (_event, type: "documents" | "downloads" | "pictures" | "music" | "videos"): string => {
      return app.getPath(type);
    },
  );

  // 遍历音乐文件
  ipcMain.handle("get-music-files", async (_, dirPath: string) => {
    try {
      // 规范化路径
      const filePath = resolve(dirPath).replace(/\\/g, "/");
      console.info(`📂 Fetching music files from: ${filePath}`);
      // 查找指定目录下的所有音乐文件
      const musicFiles = await FastGlob("**/*.{mp3,wav,flac}", { cwd: filePath });
      // 解析元信息
      const metadataPromises = musicFiles.map(async (file) => {
        const filePath = join(dirPath, file);
        // 处理元信息
        const { common, format } = await parseFile(filePath);
        // 获取文件大小
        const { size } = await stat(filePath);
        // 判断音质等级
        let quality: string;
        if ((format.sampleRate || 0) >= 96000 || (format.bitsPerSample || 0) > 16) {
          quality = "Hi-Res";
        } else if ((format.sampleRate || 0) >= 44100) {
          quality = "HQ";
        } else {
          quality = "SQ";
        }
        return {
          id: getFileID(filePath),
          name: common.title || basename(filePath),
          artists: common.artists?.[0] || common.artist,
          album: common.album || "",
          alia: common.comment?.[0]?.text || "",
          duration: (format?.duration ?? 0) * 1000,
          size: (size / (1024 * 1024)).toFixed(2),
          path: filePath,
          quality,
        };
      });
      const metadataArray = await Promise.all(metadataPromises);
      return metadataArray;
    } catch (error) {
      ipcLog.error("❌ Error fetching music metadata:", error);
      throw error;
    }
  });

  // 获取音乐元信息
  ipcMain.handle("get-music-metadata", async (_, path: string) => {
    try {
      const filePath = resolve(path).replace(/\\/g, "/");
      const { common, format } = await parseFile(filePath);
      return {
        // 文件名称
        fileName: basename(filePath),
        // 文件大小
        fileSize: (await stat(filePath)).size / (1024 * 1024),
        // 元信息
        common,
        // 歌词
        lyric:
          metaDataLyricsArrayToLrc(common?.lyrics?.[0]?.syncText || []) ||
          common?.lyrics?.[0]?.text ||
          "",
        // 音质信息
        format,
        // md5
        md5: await getFileMD5(filePath),
      };
    } catch (error) {
      ipcLog.error("❌ Error fetching music metadata:", error);
      throw error;
    }
  });

  // 修改音乐元信息
  ipcMain.handle("set-music-metadata", async (_, path: string, metadata: any) => {
    try {
      const { name, artist, album, alia, lyric, cover } = metadata;
      // 规范化路径
      const songPath = resolve(path);
      const coverPath = cover ? resolve(cover) : null;
      // 读取歌曲文件
      const songFile = File.createFromPath(songPath);
      // 读取封面文件
      const songCover = coverPath ? Picture.fromPath(coverPath) : null;
      // 保存元数据
      Id3v2Settings.forceDefaultVersion = true;
      Id3v2Settings.defaultVersion = 3;
      songFile.tag.title = name || "未知曲目";
      songFile.tag.performers = [artist || "未知艺术家"];
      songFile.tag.album = album || "未知专辑";
      songFile.tag.albumArtists = [artist || "未知艺术家"];
      songFile.tag.lyrics = lyric || "";
      songFile.tag.description = alia || "";
      songFile.tag.comment = alia || "";
      if (songCover) songFile.tag.pictures = [songCover];
      // 保存元信息
      songFile.save();
      songFile.dispose();
      return true;
    } catch (error) {
      ipcLog.error("❌ Error setting music metadata:", error);
      throw error;
    }
  });

  // 获取音乐歌词
  ipcMain.handle(
    "get-music-lyric",
    async (
      _,
      path: string,
    ): Promise<{
      lyric: string;
      format: "lrc" | "ttml";
    }> => {
      try {
        const filePath = resolve(path).replace(/\\/g, "/");
        const { common } = await parseFile(filePath);

        // 尝试获取同名的歌词文件
        const filePathWithoutExt = filePath.replace(/\.[^.]+$/, "");
        for (const ext of ["ttml", "lrc"] as const) {
          const lyricPath = `${filePathWithoutExt}.${ext}`;
          ipcLog.info("lyricPath", lyricPath);
          try {
            await access(lyricPath);
            const lyric = await readFile(lyricPath, "utf-8");
            if (lyric && lyric != "") return { lyric, format: ext };
          } catch {
            /* empty */
          }
        }

        // 尝试获取元数据
        const lyric = common?.lyrics?.[0]?.syncText;
        if (lyric && lyric.length > 0) {
          return { lyric: metaDataLyricsArrayToLrc(lyric), format: "lrc" };
        } else if (common?.lyrics?.[0]?.text) {
          return { lyric: common?.lyrics?.[0]?.text, format: "lrc" };
        }

        // 没有歌词
        return { lyric: "", format: "lrc" };
      } catch (error) {
        ipcLog.error("❌ Error fetching music lyric:", error);
        throw error;
      }
    },
  );

  // 获取音乐封面
  ipcMain.handle(
    "get-music-cover",
    async (_, path: string): Promise<{ data: Buffer; format: string } | null> => {
      try {
        const { common } = await parseFile(path);
        // 获取封面数据
        const picture = common.picture?.[0];
        if (picture) {
          return { data: Buffer.from(picture.data), format: picture.format };
        } else {
          const coverFilePath = path.replace(/\.[^.]+$/, ".jpg");
          try {
            await access(coverFilePath);
            const coverData = await readFile(coverFilePath);
            return { data: coverData, format: "image/jpeg" };
          } catch {
            return null;
          }
        }
      } catch (error) {
        console.error("❌ Error fetching music cover:", error);
        throw error;
      }
    },
  );

  // 读取本地歌词
  ipcMain.handle(
    "read-local-lyric",
    async (_, lyricDir: string, id: number, ext: string): Promise<string> => {
      const lyricPath = join(lyricDir, `${id}.${ext}`);
      try {
        await access(lyricPath);
        const lyric = await readFile(lyricPath, "utf-8");
        if (lyric) return lyric;
      } catch {
        /* empty */
      }
      return "";
    },
  );

  // 删除文件
  ipcMain.handle("delete-file", async (_, path: string) => {
    try {
      // 规范化路径
      const resolvedPath = resolve(path);
      // 检查文件是否存在
      try {
        await access(resolvedPath);
      } catch {
        throw new Error("❌ File not found");
      }
      // 删除文件
      await unlink(resolvedPath);
      return true;
    } catch (error) {
      ipcLog.error("❌ File delete error", error);
      return false;
    }
  });

  // 打开文件夹
  ipcMain.on("open-folder", async (_, path: string) => {
    try {
      // 规范化路径
      const resolvedPath = resolve(path);
      // 检查文件夹是否存在
      try {
        await access(resolvedPath);
      } catch {
        throw new Error("❌ Folder not found");
      }
      // 打开文件夹
      shell.showItemInFolder(resolvedPath);
    } catch (error) {
      ipcLog.error("❌ Folder open error", error);
      throw error;
    }
  });

  // 图片选择窗口
  ipcMain.handle("choose-image", async () => {
    try {
      const { filePaths } = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
      });
      if (!filePaths || filePaths.length === 0) return null;
      return filePaths[0];
    } catch (error) {
      ipcLog.error("❌ Image choose error", error);
      return null;
    }
  });

  // 路径选择窗口
  ipcMain.handle("choose-path", async () => {
    try {
      const { filePaths } = await dialog.showOpenDialog({
        title: "选择文件夹",
        defaultPath: app.getPath("downloads"),
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: "选择文件夹",
      });
      if (!filePaths || filePaths.length === 0) return null;
      return filePaths[0];
    } catch (error) {
      ipcLog.error("❌ Path choose error", error);
      return null;
    }
  });

  // 下载文件
  ipcMain.handle(
    "download-file",
    async (
      event,
      url: string,
      options: {
        fileName: string;
        fileType: string;
        path: string;
        downloadMeta?: boolean;
        downloadCover?: boolean;
        downloadLyric?: boolean;
        saveMetaFile?: boolean;
        lyric?: string;
        songData?: any;
      } = {
        fileName: "未知文件名",
        fileType: "mp3",
        path: app.getPath("downloads"),
      },
    ): Promise<boolean> => {
      try {
        // 获取窗口
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return false;
        // 获取配置
        const {
          fileName,
          fileType,
          path,
          lyric,
          downloadMeta,
          downloadCover,
          downloadLyric,
          saveMetaFile,
          songData,
        } = options;
        // 规范化路径
        const downloadPath = resolve(path);
        // 检查文件夹是否存在
        try {
          await access(downloadPath);
        } catch {
          throw new Error("❌ Folder not found");
        }
        // 下载文件
        const songDownload = await download(win, url, {
          directory: downloadPath,
          filename: `${fileName}.${fileType}`,
        });
        if (!downloadMeta || !songData?.cover) return true;
        // 下载封面
        const coverUrl = songData?.coverSize?.l || songData.cover;
        const coverDownload = await download(win, coverUrl, {
          directory: downloadPath,
          filename: `${fileName}.jpg`,
        });
        // 读取歌曲文件
        const songFile = File.createFromPath(songDownload.getSavePath());
        // 生成图片信息
        const songCover = Picture.fromPath(coverDownload.getSavePath());
        // 保存修改后的元数据
        Id3v2Settings.forceDefaultVersion = true;
        Id3v2Settings.defaultVersion = 3;
        songFile.tag.title = songData?.name || "未知曲目";
        songFile.tag.album = songData?.album?.name || "未知专辑";
        songFile.tag.performers = songData?.artists?.map((ar: any) => ar.name) || ["未知艺术家"];
        songFile.tag.albumArtists = songData?.artists?.map((ar: any) => ar.name) || ["未知艺术家"];
        if (lyric && downloadLyric) songFile.tag.lyrics = lyric;
        if (songCover && downloadCover) songFile.tag.pictures = [songCover];
        // 保存元信息
        songFile.save();
        songFile.dispose();
        // 创建同名歌词文件
        if (lyric && saveMetaFile && downloadLyric) {
          const lrcPath = join(downloadPath, `${fileName}.lrc`);
          await writeFile(lrcPath, lyric, "utf-8");
        }
        // 是否删除封面
        if (!saveMetaFile || !downloadCover) await unlink(coverDownload.getSavePath());
        return true;
      } catch (error) {
        ipcLog.error("❌ Error downloading file:", error);
        return false;
      }
    },
  );
};

export default initFileIpc;
