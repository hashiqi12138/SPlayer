import type { SongType, PlayModeType } from "@/types/main";
import type { MessageReactive } from "naive-ui";
import { Howl, Howler } from "howler";
import { cloneDeep } from "lodash-es";
import { useMusicStore, useStatusStore, useDataStore, useSettingStore } from "@/stores";
import { parsedLyricsData, resetSongLyric, parseLocalLyric, parseTTMLToAMLL } from "./lyric";
import { songUrl, songLyric, songChorus, songLyricTTML, unlockSongUrlNew } from "@/api/song";
import { getCoverColorData } from "@/utils/color";
import { calculateProgress } from "./time";
import { isElectron, isDev } from "./helper";
import { heartRateList } from "@/api/playlist";
import { songAsset } from "@/api/song";
import { formatSongsList } from "./format";
import { isLogin } from "./auth";
import { openUserLogin } from "./modal";
import { personalFm, personalFmToTrash } from "@/api/rec";
import blob from "./blob";
import { baseURL } from "./request";

// 播放器核心
// Howler.js

// 允许播放格式
const allowPlayFormat = ["mp3", "flac", "webm", "ogg", "wav"];

class Player {
  // 播放器
  private player: Howl;
  // 定时器
  private playerInterval: ReturnType<typeof setInterval> | undefined;
  // 频谱数据
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  // 其他数据
  private testNumber: number = 0;
  private message: MessageReactive | null = null;
  constructor() {
    // 创建播放器实例
    this.player = new Howl({ src: [""], format: allowPlayFormat, autoplay: false });
    // 初始化媒体会话
    this.initMediaSession();
  }
  /**
   * 洗牌数组（Fisher-Yates）
   */
  private shuffleArray<T>(arr: T[]): T[] {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  /**
   * 重置状态
   */
  resetStatus() {
    const statusStore = useStatusStore();
    const musicStore = useMusicStore();
    // 重置状态
    statusStore.$patch({
      currentTime: 0,
      duration: 0,
      progress: 0,
      chorus: 0,
      currentTimeOffset: 0,
      lyricIndex: -1,
      playStatus: false,
      playLoading: false,
    });
    musicStore.$patch({
      playPlaylistId: 0,
      playSong: {},
    });
  }
  /**
   * 获取当前播放歌曲
   * @returns 当前播放歌曲
   */
  private getPlaySongData(): SongType | null {
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // 若为私人FM
    if (statusStore.personalFmMode) {
      return musicStore.personalFMSong;
    }
    // 播放列表
    const playlist = dataStore.playList;
    if (!playlist.length) return null;
    return playlist[statusStore.playIndex];
  }
  /**
   * 获取淡入淡出时间
   * @returns 播放音量
   */
  private getFadeTime(): number {
    const settingStore = useSettingStore();
    const { songVolumeFade, songVolumeFadeTime } = settingStore;
    return songVolumeFade ? songVolumeFadeTime : 0;
  }
  /**
   * 处理播放状态
   */
  private handlePlayStatus() {
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    // 清理定时器
    clearInterval(this.playerInterval);
    // 更新播放状态
    this.playerInterval = setInterval(() => {
      if (!this.player.playing()) return;
      const currentTime = this.getSeek();
      const duration = this.player.duration();
      // 计算进度条距离
      const progress = calculateProgress(currentTime, duration);
      // 计算歌词索引
      const hasYrc = !musicStore.songLyric.yrcData.length || !settingStore.showYrc;
      const lyrics = hasYrc ? musicStore.songLyric.lrcData : musicStore.songLyric.yrcData;
      // 歌词实时偏移量
      const currentTimeOffset = statusStore.currentTimeOffset;
      const index = lyrics?.findIndex((v) => v?.time >= currentTime + currentTimeOffset);
      // 歌词跨界处理
      const lyricIndex = index === -1 ? lyrics.length - 1 : index - 1;
      // 更新状态
      statusStore.$patch({ currentTime, duration, progress, lyricIndex });
      // 客户端事件
      if (isElectron) {
        // 歌词变化
        window.electron.ipcRenderer.send("play-lyric-change", {
          index: lyricIndex,
          lyric: cloneDeep(
            settingStore.showYrc && musicStore.songLyric.yrcData?.length
              ? musicStore.songLyric.yrcData
              : musicStore.songLyric.lrcData,
          ),
        });
        // 进度条
        if (settingStore.showTaskbarProgress) {
          window.electron.ipcRenderer.send("set-bar", progress);
        }
      }
    }, 250);
  }
  /**
   * 获取在线播放链接
   * @param id 歌曲id
   * @returns 播放链接
   */
  private async getOnlineUrl(id: number): Promise<string | null> {
    const settingStore = useSettingStore();
    const res = await songUrl(id, settingStore.songLevel);
    console.log(`🌐 ${id} music data:`, res);
    const songData = res.data?.[0];
    // 是否有播放地址
    if (!songData || !songData?.url) return null;
    // 是否仅能试听
    if (songData?.freeTrialInfo !== null) {
      if (settingStore.playSongDemo) {
        window.$message.warning("当前歌曲仅可试听，请开通会员后重试");
      } else return null;
    }
    // 返回歌曲地址
    // 客户端直接返回，网页端转 https, 并转换url以便解决音乐链接cors问题
    const url = songData.url;
    console.log(`🎧 ${id} music url:`, url);
    return url;
  }
  /**
   * 获取解锁播放链接
   * @param songData 歌曲数据
   * @returns
   */
  private async getUnlockSongUrl(songData: SongType): Promise<string | null> {
    try {
      const songId = songData.id;
      const artist = Array.isArray(songData.artists) ? songData.artists[0].name : songData.artists;
      const keyWord = songData.name + "-" + artist;
      if (!songId || !keyWord) return null;
      // 尝试解锁
      const results = await Promise.allSettled([
        unlockSongUrlNew(songId, keyWord),
      ]);
      // 解析结果
      const [neteaseRes] = results;
      if (
        neteaseRes.status === "fulfilled" &&
        neteaseRes.value.code === 200 &&
        neteaseRes.value.data &&
        neteaseRes.value.data.url
      ) {
        return neteaseRes.value.data.url;
      }
      return null;
    } catch (error) {
      console.error("Error in getUnlockSongUrl", error);
      return null;
    }
  }
  /**
   * 创建播放器
   * @param src 播放地址
   * @param autoPlay 是否自动播放
   * @param seek 播放位置
   */
  private async createPlayer(src: string, autoPlay: boolean = true, seek: number = 0) {
    // 获取数据
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    // 播放信息
    const { id, path, type } = musicStore.playSong;

    const arraybuffer = await songAsset(location.origin + '/proxy/' + src)

    // 清理播放器
    Howler.unload();

    console.log(arraybuffer)

    // const blob = new Blob([arraybuffer], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(arraybuffer.data);

    // const url = '/proxy/' + src


    // 创建播放器
    this.player = new Howl({
      // src: baseURL + '/song/asset/v1?url=' + encodeURIComponent(src),
      src: url,
      // src,
      format: allowPlayFormat,
      html5: true,
      autoplay: autoPlay,
      preload: "metadata",
      pool: 1,
      volume: statusStore.playVolume,
      rate: statusStore.playRate,
    });
    // 播放器事件
    this.playerEvent({ seek });
    // 播放设备
    if (!settingStore.showSpectrums) this.toggleOutputDevice();
    // 自动播放
    if (autoPlay) this.play();
    // 获取歌曲附加信息 - 非电台和本地
    if (type !== "radio" && !path) {
      this.getLyricData(id);
      this.getChorus(id);
    } else resetSongLyric();
    // 定时获取状态
    if (!this.playerInterval) this.handlePlayStatus();
    // 新增播放历史
    if (type !== "radio") dataStore.setHistory(musicStore.playSong);
    // 获取歌曲封面主色
    if (!path) this.getCoverColor(musicStore.songCover);
    // 更新 MediaSession
    if (!path) this.updateMediaSession();
    // 开发模式
    if (isDev) window.player = this.player;
  }
  /**
   * 播放器事件
   */
  private playerEvent(
    options: {
      // 恢复进度
      seek?: number;
    } = { seek: 0 },
  ) {
    // 获取数据
    const dataStore = useDataStore();
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    const playSongData = this.getPlaySongData();
    // 获取配置
    const { seek } = options;
    // 初次加载
    this.player.once("load", () => {
      // 允许跨域
      if (settingStore.showSpectrums) {
        const audioDom = this.getAudioDom();
        audioDom.crossOrigin = "anonymous";
      }
      // 恢复进度（ 需距离本曲结束大于 2 秒 ）
      if (seek && statusStore.duration - statusStore.currentTime > 2) this.setSeek(seek);
      // 更新状态
      statusStore.playLoading = false;
      // ipc
      if (isElectron) {
        window.electron.ipcRenderer.send("play-song-change", this.getPlayerInfo());
        window.electron.ipcRenderer.send(
          "like-status-change",
          dataStore.isLikeSong(playSongData?.id || 0),
        );
      }
    });
    // 播放
    this.player.on("play", () => {
      window.document.title = this.getPlayerInfo() || "SPlayer";
      // ipc
      if (isElectron) {
        window.electron.ipcRenderer.send("play-status-change", true);
        window.electron.ipcRenderer.send("play-song-change", this.getPlayerInfo());
      }
      console.log("▶️ song play:", playSongData);
    });
    // 暂停
    this.player.on("pause", () => {
      if (!isElectron) window.document.title = "SPlayer";
      // ipc
      if (isElectron) window.electron.ipcRenderer.send("play-status-change", false);
      console.log("⏸️ song pause:", playSongData);
    });
    // 结束
    this.player.on("end", () => {
      // statusStore.playStatus = false;
      console.log("⏹️ song end:", playSongData);
      this.nextOrPrev("next");
    });
    // 错误
    this.player.on("loaderror", (sourceid, err: any) => {
      this.errorNext(err);
      console.error("❌ song error:", sourceid, playSongData, err);
    });
  }
  /**
   * 初始化 MediaSession
   */
  private initMediaSession() {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => this.play());
    navigator.mediaSession.setActionHandler("pause", () => this.pause());
    navigator.mediaSession.setActionHandler("previoustrack", () => this.nextOrPrev("prev"));
    navigator.mediaSession.setActionHandler("nexttrack", () => this.nextOrPrev("next"));
    // 跳转进度
    navigator.mediaSession.setActionHandler("seekto", (event) => {
      if (event.seekTime) this.setSeek(event.seekTime);
    });
  }
  /**
   * 更新 MediaSession
   */
  private updateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const musicStore = useMusicStore();
    const settingStore = useSettingStore();
    // 获取播放数据
    const playSongData = this.getPlaySongData();
    if (!playSongData) return;
    // 播放状态
    const isRadio = playSongData.type === "radio";
    // 获取数据
    const metaData: MediaMetadataInit = {
      title: playSongData.name,
      artist: isRadio
        ? "播客电台"
        : // 非本地歌曲且歌手列表为数组
          Array.isArray(playSongData.artists)
          ? playSongData.artists.map((item) => item.name).join(" / ")
          : String(playSongData.artists),
      album: isRadio
        ? "播客电台"
        : // 是否为对象
          typeof playSongData.album === "object"
          ? playSongData.album.name
          : String(playSongData.album),
      artwork: settingStore.smtcOutputHighQualityCover
        ? [
            {
              src: musicStore.getSongCover("xl"),
              sizes: "1920x1920",
              type: "image/jpeg",
            },
          ]
        : [
            {
              src: musicStore.getSongCover("cover"),
              sizes: "512x512",
              type: "image/jpeg",
            },
            {
              src: musicStore.getSongCover("s"),
              sizes: "100x100",
              type: "image/jpeg",
            },
            {
              src: musicStore.getSongCover("m"),
              sizes: "300x300",
              type: "image/jpeg",
            },
            {
              src: musicStore.getSongCover("l"),
              sizes: "1024x1024",
              type: "image/jpeg",
            },
            {
              src: musicStore.getSongCover("xl"),
              sizes: "1920x1920",
              type: "image/jpeg",
            },
          ],
    };
    // 更新数据
    navigator.mediaSession.metadata = new window.MediaMetadata(metaData);
  }
  // 生成频谱数据
  private generateSpectrumData() {
    const statusStore = useStatusStore();
    if (!this.analyser || !this.dataArray) {
      this.initSpectrumData();
    }
    // 更新频谱数据
    const updateSpectrumData = () => {
      if (this.analyser && this.dataArray) {
        this.analyser.getByteFrequencyData(this.dataArray);
        // 保存数据
        statusStore.spectrumsData = Array.from(this.dataArray);
      }
      requestAnimationFrame(updateSpectrumData);
    };
    updateSpectrumData();
  }
  /**
   * 获取歌词
   * @param id 歌曲id
   */
  private async getLyricData(id: number) {
    if (!id) {
      resetSongLyric();
      return;
    }

    try {
      const musicStore = useMusicStore();
      const settingStore = useSettingStore();
      const [lyricRes, ttmlContent] = await Promise.all([
        songLyric(id),
        // songLyricTTML(id)
      ]);
      parsedLyricsData(lyricRes);
      if (ttmlContent && settingStore.enableTTMLLyric) {
        const ttmlLyric = parseTTMLToAMLL(ttmlContent);
        if (ttmlLyric?.length > 0) {
          settingStore.showYrc = true;
          musicStore.songLyric = {
            ...musicStore.songLyric,
            yrcAMData: ttmlLyric,
          };
          console.log("✅ TTML lyrics enabled");
          return;
        }
      }

    } catch (error) {
      console.error("❌ Error loading lyrics:", error);
      resetSongLyric();
    }
  }
  /**
   * 获取副歌时间
   * @param id 歌曲id
   */
  private async getChorus(id: number) {
    const statusStore = useStatusStore();
    const result = await songChorus(id);
    if (result?.code !== 200 || result?.chorus?.length === 0) {
      statusStore.chorus = 0;
      return;
    }
    // 计算并保存
    const chorus = result?.chorus?.[0]?.startTime;
    const time = ((chorus / 1000 / statusStore.duration) * 100).toFixed(2);
    statusStore.chorus = Number(time);
  }
  /**
   * 播放错误
   * 在播放错误时，播放下一首
   */
  private async errorNext(errCode?: number) {
    const dataStore = useDataStore();
    // 次数加一
    this.testNumber++;
    if (this.testNumber > 5) {
      this.testNumber = 0;
      this.resetStatus();
      window.$message.error("当前重试次数过多，请稍后再试");
      return;
    }
    // 错误 2 通常为网络地址过期
    if (errCode === 2) {
      // 重载播放器
      await this.initPlayer(true, this.getSeek());
      return;
    }
    // 播放下一曲
    if (dataStore.playList.length > 1) {
      await this.nextOrPrev("next");
    } else {
      window.$message.error("当前列表暂无可播放歌曲");
      this.cleanPlayList();
    }
  }
  /**
   * 获取 Audio Dom
   */
  private getAudioDom() {
    const audioDom = (this.player as any)._sounds[0]._node;
    if (!audioDom) {
      throw new Error("Audio Dom is null");
    }
    return audioDom;
  }
  /**
   * 获取本地歌曲元信息
   * @param path 歌曲路径
   */
  private async parseLocalMusicInfo(path: string) {
    try {
      const musicStore = useMusicStore();
      // 获取封面数据
      const coverData = await window.electron.ipcRenderer.invoke("get-music-cover", path);
      if (coverData) {
        const { data, format } = coverData;
        const blobURL = blob.createBlobURL(data, format, path);
        if (blobURL) {
          musicStore.playSong.cover = blobURL;
        }
      } else {
        musicStore.playSong.cover = "/images/song.jpg?assest";
      }
      // 获取主色
      this.getCoverColor(musicStore.playSong.cover);
      // 获取歌词数据
      const lrcData = await window.electron.ipcRenderer.invoke("get-music-lyric", path);
      parseLocalLyric(lrcData);
      // 更新媒体会话
      this.updateMediaSession();
    } catch (error) {
      window.$message.error("获取本地歌曲元信息失败");
      console.error("Failed to parse local music info:", error);
    }
  }
  /**
   * 获取播放信息
   * @param song 歌曲
   * @param sep 分隔符
   * @returns 播放信息
   */
  getPlayerInfo(song?: SongType, sep: string = "/"): string | null {
    const playSongData = song || this.getPlaySongData();
    if (!playSongData) return null;
    // 标题
    const title = `${playSongData.name || "未知歌曲"}`;
    // 歌手
    const artist =
      playSongData.type === "radio"
        ? "播客电台"
        : Array.isArray(playSongData.artists)
          ? playSongData.artists.map((artists: { name: string }) => artists.name).join(sep)
          : String(playSongData?.artists || "未知歌手");
    return `${title} - ${artist}`;
  }
  /**
   * 初始化播放器
   * 核心外部调用
   * @param autoPlay 是否自动播放
   * @param seek 播放位置
   */
  async initPlayer(autoPlay: boolean = true, seek: number = 0) {
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    try {
      // 获取播放数据
      const playSongData = this.getPlaySongData();
      if (!playSongData) return;
      const { id, dj, path, type } = playSongData;
      // 更改当前播放歌曲
      musicStore.playSong = playSongData;
      // 更改状态
      statusStore.playLoading = true;
      // 本地歌曲
      if (path) {
        await this.createPlayer(`file://${path}`, autoPlay, seek);
        // 获取歌曲元信息
        await this.parseLocalMusicInfo(path);
      }
      // 在线歌曲
      else if (id && dataStore.playList.length) {
        const songId = type === "radio" ? dj?.id : id;
        if (!songId) throw new Error("Get song id error");
        const url = await this.getOnlineUrl(songId);
        // 正常播放地址
        if (url) {
          statusStore.playUblock = false;
          await this.createPlayer(url, autoPlay, seek);
        }
        // 尝试解灰
        else if (type !== "radio" && settingStore.useSongUnlock) {
          const unlockUrl = await this.getUnlockSongUrl(playSongData);
          if (unlockUrl) {
            statusStore.playUblock = true;
            console.log("🎼 Song unlock successfully:", unlockUrl);
            await this.createPlayer(unlockUrl, autoPlay, seek);
          } else {
            statusStore.playUblock = false;
            // 是否为最后一首
            if (statusStore.playIndex === dataStore.playList.length - 1) {
              statusStore.$patch({ playStatus: false, playLoading: false });
              window.$message.warning("当前列表歌曲无法播放，请更换歌曲");
            } else {
              window.$message.error("该歌曲暂无音源，跳至下一首");
              this.nextOrPrev("next");
            }
          }
        } else {
          if (dataStore.playList.length === 1) {
            this.resetStatus();
            window.$message.warning("当前播放列表已无可播放歌曲，请更换");
            return;
          } else {
            window.$message.error("该歌曲无法播放，跳至下一首");
            this.nextOrPrev();
            return;
          }
        }
      }
    } catch (error) {
      console.error("❌ 初始化音乐播放器出错：", error);
      window.$message.error("播放器遇到错误，请尝试软件热重载");
      // this.errorNext();
    }
  }
  /**
   * 播放
   */
  async play() {
    const statusStore = useStatusStore();
    // 已在播放
    if (this.player.playing()) {
      statusStore.playStatus = true;
      return;
    }
    this.player.play();
    // 淡入
    await new Promise<void>((resolve) => {
      this.player.once("play", () => {
        // 在淡入开始时立即设置播放状态
        statusStore.playStatus = true;
        this.player.fade(0, statusStore.playVolume, this.getFadeTime());
        resolve();
      });
    });
  }
  /**
   * 暂停
   * @param changeStatus 是否更改播放状态
   */
  async pause(changeStatus: boolean = true) {
    const statusStore = useStatusStore();

    // 播放器未加载完成
    if (this.player.state() !== "loaded") {
      return;
    }

    // 立即设置播放状态
    if (changeStatus) statusStore.playStatus = false;
    
    // 淡出
    await new Promise<void>((resolve) => {
      this.player.fade(statusStore.playVolume, 0, this.getFadeTime());
      this.player.once("fade", () => {
        this.player.pause();
        resolve();
      });
    });
  }
  /**
   * 播放或暂停
   */
  async playOrPause() {
    const statusStore = useStatusStore();
    if (statusStore.playStatus) await this.pause();
    else await this.play();
  }
  /**
   * 下一首或上一首
   * @param type 切换类别 next 下一首 prev 上一首
   * @param play 是否立即播放
   */
  async nextOrPrev(type: "next" | "prev" = "next", play: boolean = true) {
    try {
      const statusStore = useStatusStore();
      const dataStore = useDataStore();
      const musicStore = useMusicStore();
      // 获取数据
      const { playList } = dataStore;
      const { playSong } = musicStore;
      const { playSongMode, playHeartbeatMode } = statusStore;
      // 列表长度
      const playListLength = playList.length;
      // 播放列表是否为空
      if (playListLength === 0) throw new Error("Play list is empty");
      // 若为私人FM
      if (statusStore.personalFmMode) {
        await this.initPersonalFM(true);
        return;
      }
      // 只有一首歌的特殊处理
      if (playListLength === 1) {
        statusStore.lyricIndex = -1;
        this.setSeek(0);
        await this.play();
      }
      // 列表循环或处于心动模式或随机模式
      if (
        playSongMode === "repeat" ||
        playSongMode === "shuffle" ||
        playHeartbeatMode ||
        playSong.type === "radio"
      ) {
        statusStore.playIndex += type === "next" ? 1 : -1;
      }
      // 单曲循环
      else if (playSongMode === "repeat-once") {
        statusStore.lyricIndex = -1;
        this.setSeek(0);
        await this.play();
        return;
      } else {
        throw new Error("The play mode is not supported");
      }
      // 索引是否越界
      if (statusStore.playIndex < 0) {
        statusStore.playIndex = playListLength - 1;
      } else if (statusStore.playIndex >= playListLength) {
        statusStore.playIndex = 0;
      }
      // 暂停
      await this.pause(false);
      // 初始化播放器
      await this.initPlayer(play);
    } catch (error) {
      console.error("Error in nextOrPrev:", error);
      throw error;
    }
  }
  /**
   * 切换播放模式
   * @param mode 播放模式 repeat / repeat-once / shuffle
   */
  async togglePlayMode(mode: PlayModeType | false) {
    const statusStore = useStatusStore();
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    // 退出心动模式
    if (statusStore.playHeartbeatMode) this.toggleHeartMode(false);
    // 计算目标模式
    let targetMode: PlayModeType;
    if (mode) {
      targetMode = mode;
    } else {
      switch (statusStore.playSongMode) {
        case "repeat":
          targetMode = "repeat-once";
          break;
        case "shuffle":
          targetMode = "repeat";
          break;
        case "repeat-once":
          targetMode = "shuffle";
          break;
        default:
          targetMode = "repeat";
      }
    }
    // 进入随机模式：保存原顺序并打乱当前歌单
    if (targetMode === "shuffle" && statusStore.playSongMode !== "shuffle") {
      const currentList = dataStore.playList;
      if (currentList && currentList.length > 1) {
        const currentSongId = musicStore.playSong?.id;
        await dataStore.setOriginalPlayList(currentList);
        const shuffled = this.shuffleArray(currentList);
        await dataStore.setPlayList(shuffled);
        if (currentSongId) {
          const newIndex = shuffled.findIndex((s: any) => s?.id === currentSongId);
          if (newIndex !== -1) useStatusStore().playIndex = newIndex;
        }
      }
    }
    // 离开随机模式：恢复到原顺序
    if (
      statusStore.playSongMode === "shuffle" &&
      (targetMode === "repeat" || targetMode === "repeat-once")
    ) {
      const original = await dataStore.getOriginalPlayList();
      if (original && original.length) {
        const currentSongId = musicStore.playSong?.id;
        await dataStore.setPlayList(original);
        if (currentSongId) {
          const origIndex = original.findIndex((s: any) => s?.id === currentSongId);
          useStatusStore().playIndex = origIndex !== -1 ? origIndex : 0;
        } else {
          useStatusStore().playIndex = 0;
        }
        await dataStore.clearOriginalPlayList();
      }
    }
    // 应用模式
    statusStore.playSongMode = targetMode;
    this.playModeSyncIpc();
  }
  /**
   * 播放模式同步 ipc
   */
  playModeSyncIpc() {
    const statusStore = useStatusStore();
    if (isElectron) {
      window.electron.ipcRenderer.send("play-mode-change", statusStore.playSongMode);
    }
  }
  /**
   * 设置播放进度
   * @param time 播放进度
   */
  setSeek(time: number) {
    const statusStore = useStatusStore();
    this.player.seek(time);
    statusStore.currentTime = time;
  }
  /**
   * 获取播放进度
   * @returns 播放进度
   */
  getSeek(): number {
    return this.player.seek();
  }
  /**
   * 设置播放速率
   * @param rate 播放速率
   */
  setRate(rate: number) {
    const statusStore = useStatusStore();
    this.player.rate(rate);
    statusStore.playRate = rate;
  }
  /**
   * 设置播放音量
   * @param actions 音量
   */
  setVolume(actions: number | "up" | "down" | WheelEvent) {
    const statusStore = useStatusStore();
    const increment = 0.05;
    // 直接设置
    if (typeof actions === "number") {
      actions = Math.max(0, Math.min(actions, 1));
    }
    // 分类调节
    else if (actions === "up" || actions === "down") {
      statusStore.playVolume = Math.max(
        0,
        Math.min(statusStore.playVolume + (actions === "up" ? increment : -increment), 1),
      );
    }
    // 鼠标滚轮
    else {
      const deltaY = actions.deltaY;
      const volumeChange = deltaY > 0 ? -increment : increment;
      statusStore.playVolume = Math.max(0, Math.min(statusStore.playVolume + volumeChange, 1));
    }
    // 调整音量
    this.player.volume(statusStore.playVolume);
  }
  /**
   * 切换静音
   */
  toggleMute() {
    const statusStore = useStatusStore();
    // 是否静音
    const isMuted = statusStore.playVolume === 0;
    // 恢复音量
    if (isMuted) {
      statusStore.playVolume = statusStore.playVolumeMute;
    }
    // 保存当前音量并静音
    else {
      statusStore.playVolumeMute = this.player.volume();
      statusStore.playVolume = 0;
    }
    this.player.volume(statusStore.playVolume);
  }
  /**
   * 获取歌曲封面颜色数据
   * @param coverUrl 歌曲封面地址
   */
  async getCoverColor(coverUrl: string) {
    if (!coverUrl) return;
    const statusStore = useStatusStore();
    // 创建图像元素
    const image = new Image();
    image.crossOrigin = "Anonymous";
    image.src = coverUrl;
    // 图像加载完成
    image.onload = () => {
      // 获取图片数据
      const coverColorData = getCoverColorData(image);
      if (coverColorData) statusStore.songCoverTheme = coverColorData;
      // 移除元素
      image.remove();
    };
  }
  /**
   * 更新播放列表
   * @param data 播放列表
   * @param song 当前播放歌曲
   * @param pid 播放列表id
   * @param options 配置
   * @param options.showTip 是否显示提示
   * @param options.scrobble 是否打卡
   * @param options.play 是否直接播放
   */
  async updatePlayList(
    data: SongType[],
    song?: SongType,
    pid?: number,
    options: {
      showTip?: boolean;
      scrobble?: boolean;
      play?: boolean;
    } = {
      showTip: true,
      scrobble: true,
      play: true,
    },
  ) {
    if (!data || !data.length) return;
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // 获取配置
    const { showTip, play } = options;
    
    // 处理随机播放模式
    let processedData = cloneDeep(data);
    if (statusStore.playSongMode === "shuffle") {
      // 保存原始播放列表
      await dataStore.setOriginalPlayList(cloneDeep(data));
      // 随机排序
      processedData = this.shuffleArray(processedData);
    }
    
    // 更新列表
    await dataStore.setPlayList(processedData);
    // 关闭特殊模式
    if (statusStore.playHeartbeatMode) this.toggleHeartMode(false);
    if (statusStore.personalFmMode) statusStore.personalFmMode = false;
    // 是否直接播放
    if (song && typeof song === "object" && "id" in song) {
      // 是否为当前播放歌曲
      if (musicStore.playSong.id === song.id) {
        if (play) await this.play();
      } else {
        // 查找索引（在处理后的列表中查找）
        statusStore.playIndex = processedData.findIndex((item) => item.id === song.id);
        // 播放
        await this.pause(false);
        await this.initPlayer();
      }
    } else {
      statusStore.playIndex =
        statusStore.playSongMode === "shuffle" ? Math.floor(Math.random() * processedData.length) : 0;
      // 播放
      await this.pause(false);
      await this.initPlayer();
    }
    // 更改播放歌单
    musicStore.playPlaylistId = pid ?? 0;
    if (showTip) window.$message.success("已开始播放");
  }
  /**
   * 添加下一首歌曲
   * @param song 歌曲
   * @param play 是否立即播放
   */
  async addNextSong(song: SongType, play: boolean = false) {
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // 关闭特殊模式
    if (statusStore.personalFmMode) statusStore.personalFmMode = false;
    // 是否为当前播放歌曲
    if (musicStore.playSong.id === song.id) {
      this.play();
      window.$message.success("已开始播放");
      return;
    }
    // 尝试添加
    const songIndex = await dataStore.setNextPlaySong(song, statusStore.playIndex);
    // 播放歌曲
    if (songIndex < 0) return;
    if (play) this.togglePlayIndex(songIndex, true);
    else window.$message.success("已添加至下一首播放");
  }
  /**
   * 切换播放索引
   * @param index 播放索引
   * @param play 是否立即播放
   */
  async togglePlayIndex(index: number, play: boolean = false) {
    const dataStore = useDataStore();
    const statusStore = useStatusStore();
    // 获取数据
    const { playList } = dataStore;
    // 若超出播放列表
    if (index >= playList.length) return;
    // 相同
    if (!play && statusStore.playIndex === index) {
      this.play();
      return;
    }
    // 更改状态
    statusStore.playIndex = index;
    // 清理并播放
    this.resetStatus();
    await this.initPlayer();
  }
  /**
   * 移除指定歌曲
   * @param index 歌曲索引
   */
  removeSongIndex(index: number) {
    const dataStore = useDataStore();
    const statusStore = useStatusStore();
    // 获取数据
    const { playList } = dataStore;
    // 若超出播放列表
    if (index >= playList.length) return;
    // 仅剩一首
    if (playList.length === 1) {
      this.cleanPlayList();
      return;
    }
    // 是否为当前播放歌曲
    const isCurrentPlay = statusStore.playIndex === index;
    // 深拷贝，防止影响原数据
    const newPlaylist = cloneDeep(playList);
    // 若将移除最后一首
    if (index === playList.length - 1) {
      statusStore.playIndex = 0;
    }
    // 若为当前播放之后
    else if (statusStore.playIndex > index) {
      statusStore.playIndex--;
    }
    // 移除指定歌曲
    newPlaylist.splice(index, 1);
    dataStore.setPlayList(newPlaylist);
    // 若为当前播放
    if (isCurrentPlay) {
      this.initPlayer(statusStore.playStatus);
    }
  }
  /**
   * 清空播放列表
   */
  async cleanPlayList() {
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // 停止播放
    Howler.unload();
    // 清空数据
    this.resetStatus();
    statusStore.$patch({
      playListShow: false,
      showFullPlayer: false,
      playHeartbeatMode: false,
      personalFmMode: false,
      playIndex: -1,
    });
    musicStore.resetMusicData();
    dataStore.setPlayList([]);
    window.$message.success("已清空播放列表");
  }
  /**
   * 切换输出设备
   * @param deviceId 输出设备
   */
  toggleOutputDevice(deviceId?: string) {
    try {
      const settingStore = useSettingStore();
      // 输出设备
      const devices = deviceId ?? settingStore.playDevice;
      if (!(this.player as any)?._sounds.length) return;
      // 获取音频元素
      const audioDom = this.getAudioDom();
      // 设置输出设备
      if (devices && audioDom?.setSinkId) {
        audioDom.setSinkId(devices);
      }
    } catch (error) {
      console.error("Failed to change audio output device:", error);
    }
  }
  /**
   * 初始化音频可视化
   */
  initSpectrumData() {
    try {
      if (this.audioContext) return;
      // AudioContext
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      // 获取音频元素
      const audioDom = this.getAudioDom();
      // 媒体元素源
      this.source = this.audioContext.createMediaElementSource(audioDom);
      // AnalyserNode
      this.analyser = this.audioContext.createAnalyser();
      // 频谱分析器 FFT
      this.analyser.fftSize = 512;
      // 连接源和分析节点
      this.source.connect(this.analyser);
      // 连接分析节点到 AudioContext
      this.analyser.connect(this.audioContext.destination);
      // 配置 AnalyserNode
      const bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(bufferLength);
      // 更新频谱数据
      this.generateSpectrumData();
      console.log("🎼 Initialize music spectrum successfully");
    } catch (error) {
      console.error("🎼 Initialize music spectrum failed:", error);
    }
  }
  /**
   * 切换桌面歌词
   */
  toggleDesktopLyric() {
    const statusStore = useStatusStore();
    const show = !statusStore.showDesktopLyric;
    statusStore.showDesktopLyric = show;
    window.electron.ipcRenderer.send("change-desktop-lyric", show);
    window.$message.success(`${show ? "已开启" : "已关闭"}桌面歌词`);
  }
  /**
   * 切换心动模式
   * @param open 是否开启
   */
  async toggleHeartMode(open: boolean = true) {
    try {
      const dataStore = useDataStore();
      const musicStore = useMusicStore();
      const statusStore = useStatusStore();
      if (!open && statusStore.playHeartbeatMode) {
        statusStore.playHeartbeatMode = false;
        window.$message.success("已退出心动模式");
        return;
      }
      if (isLogin() !== 1) {
        if (isLogin() === 0) {
          openUserLogin(true);
        } else {
          window.$message.warning("该登录模式暂不支持该操作");
        }
        return;
      }
      if (statusStore.playHeartbeatMode) {
        window.$message.warning("已处于心动模式");
        this.play();
        return;
      }
      this.message?.destroy();
      this.message = window.$message.loading("心动模式开启中", { duration: 0 });
      // 获取所需数据
      const playSongData = this.getPlaySongData();
      const likeSongsList: any = await dataStore.getUserLikePlaylist();
      // if (!playSongData || !likeSongsList) {
      //   throw new Error("获取播放数据或喜欢列表失败");
      // }
      const pid =
        musicStore.playPlaylistId && musicStore.playPlaylistId !== 0
          ? musicStore.playPlaylistId
          : likeSongsList?.detail?.id;
      // 开启心动模式
      const result = await heartRateList(playSongData?.id || 0, pid);
      if (result.code === 200) {
        this.message?.destroy();
        const heartRatelists = formatSongsList(result.data);
        // 更新播放列表
        await this.updatePlayList(heartRatelists, heartRatelists[0]);
        // 更改模式
        statusStore.playHeartbeatMode = true;
      } else {
        this.message?.destroy();
        window.$message.error(result.message || "心动模式开启出错，请重试");
      }
    } catch (error) {
      console.error("Failed to toggle heart mode:", error);
      this.message?.destroy();
      window.$message.error("心动模式开启出错，请重试");
    } finally {
      this.message?.destroy();
    }
  }
  /**
   * 初始化私人FM
   * @param playNext 是否播放下一首
   */
  async initPersonalFM(playNext: boolean = false) {
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    try {
      // 获取并重置
      const getPersonalFmData = async () => {
        const result = await personalFm();
        const songData = formatSongsList(result.data);
        console.log(`🌐 personal FM:`, songData);
        musicStore.personalFM.list = songData;
        musicStore.personalFM.playIndex = 0;
      };
      // 若为空
      if (musicStore.personalFM.list.length === 0) await getPersonalFmData();
      // 若需播放下一首
      if (playNext) {
        statusStore.personalFmMode = true;
        // 更改索引
        if (musicStore.personalFM.playIndex < musicStore.personalFM.list.length - 1) {
          musicStore.personalFM.playIndex++;
        } else {
          await getPersonalFmData();
        }
        // 清理并播放
        this.resetStatus();
        await this.initPlayer();
      }
    } catch (error) {
      console.error("Failed to initialize personal FM:", error);
    }
  }
  /**
   * 私人FM - 垃圾桶
   * @param id 歌曲id
   */
  async personalFMTrash(id: number) {
    try {
      const statusStore = useStatusStore();
      if (!isLogin()) {
        openUserLogin(true);
        return;
      }
      // 更改模式
      statusStore.personalFmMode = true;
      statusStore.playHeartbeatMode = false;
      // 加入回收站
      const result = await personalFmToTrash(id);
      if (result.code === 200) {
        window.$message.success("已移至垃圾桶");
        this.nextOrPrev("next");
      }
    } catch (error) {
      console.error("Error adding to trash:", error);
      window.$message.error("移至垃圾桶失败，请重试");
    }
  }
}

export default new Player();
