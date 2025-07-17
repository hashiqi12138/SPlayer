export async function useHeadphone(onDeviceChange) {
  if (!navigator.mediaDevices) {
      return
  }
  console.log(navigator)
  console.log(navigator.mediaDevices)
  await navigator.mediaDevices.getUserMedia({ audio: true });
  navigator.mediaDevices.addEventListener("devicechange", () => {
    // Do whatever you need to with the devices
    // Maybe use enumerateDevices() to see what connected
    console.log('on change')
    onDeviceChange();
  });
}

// 耳机状态管理器
export class HeadphoneDetector {
  constructor() {
    this.isListening = false;
    this.currentOutputDeviceId = null;
    this.headphoneChangeCallbacks = [];
    this.pollingInterval = null;
    this.audioContext = null;
    this.lastMediaDeviceLength = -1
  }

  // 开始监听耳机状态变化
  async startListening() {
    if (this.isListening) return;

    try {
      // 检查浏览器兼容性
      if (!this._checkCompatibility()) {
        console.warn("当前浏览器不支持耳机状态监听");
        return false;
      }

      // 请求媒体权限（需要用户交互触发）
      await this._requestMediaPermission();

      // 初始化音频上下文用于输出设备检测
      await this._initAudioContext();

      // 获取初始输出设备
      await this._updateCurrentOutputDevice();

      // 方法1: 使用 devicechange 事件（如果支持）
      if ("ondevicechange" in navigator.mediaDevices) {
        navigator.mediaDevices.addEventListener("devicechange", this._onDeviceChange.bind(this));
      }

      // 方法2: 使用定期轮询（作为后备方案）
      this.pollingInterval = setInterval(async () => {
        await this._updateCurrentOutputDevice();
      }, 200); // 每2秒检查一次

      this.isListening = true;
      return true;
    } catch (error) {
      console.error("启动耳机监听失败:", error);
      this.stopListening();
      return false;
    }
  }

  // 停止监听
  stopListening() {
    if ("ondevicechange" in navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener("devicechange", this._onDeviceChange);
    }

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.isListening = false;
  }

  // 注册状态变化回调
  onHeadphoneChange(callback) {
    if (typeof callback === "function") {
      this.headphoneChangeCallbacks.push(callback);
    }
  }

  // 检查浏览器兼容性
  _checkCompatibility() {
    return (
      "mediaDevices" in navigator &&
      "enumerateDevices" in navigator.mediaDevices &&
      (window.AudioContext || window.webkitAudioContext)
    );
  }

  // 请求媒体权限
  async _requestMediaPermission() {
    try {
      console.log(navigator)
      // 检查当前权限状态
      const permissionStatus = await navigator.permissions.query({ name: "microphone" });

      if (permissionStatus.state === "granted") {
        return true;
      }

      // 如果未授权，请求麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop()); // 立即停止流
      return true;
    } catch (error) {
      console.error("获取媒体权限失败:", error);
      return true
    }
  }

  // 初始化音频上下文
  async _initAudioContext() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContext();

      // 在 iOS 上需要用户交互来恢复音频上下文
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }
    } catch (error) {
      console.error("初始化音频上下文失败:", error);
      this.audioContext = null;
    }
  }

  // 更新当前输出设备
  async _updateCurrentOutputDevice() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      if (this.lastMediaDeviceLength === -1) {
        this.lastMediaDeviceLength = devices.length
      } else {
        if (this.lastMediaDeviceLength !== devices.length) {
          this._notifyHeadphoneChange()
          this.lastMediaDeviceLength = devices.length
        }
      }
      
      // console.log('[headphone] get devices', devices)
      const audioOutputDevices = devices.filter((device) => device.kind === "audiooutput");

      // 获取默认输出设备
      const defaultOutput = audioOutputDevices.find(
        (device) => device.deviceId === "default" || device.deviceId === "communications",
      );

      // 如果找到默认输出设备
      if (defaultOutput) {
        const isNewDevice = this.currentOutputDeviceId !== defaultOutput.deviceId;

        if (isNewDevice && this.currentOutputDeviceId !== null) {
          // 设备已更改，判断是否为耳机
          const isHeadphone = this._isLikelyHeadphone(defaultOutput);
          this._notifyHeadphoneChange(isHeadphone);
        }

        this.currentOutputDeviceId = defaultOutput.deviceId;
      }
    } catch (error) {
      console.error("更新输出设备失败:", error);
    }
  }

  // 判断是否可能是耳机设备
  _isLikelyHeadphone(device) {
    const deviceLabel = device.label.toLowerCase();

    // 通过标签判断是否为耳机或蓝牙耳机
    return (
      deviceLabel.includes("headphone") ||
      deviceLabel.includes("headset") ||
      deviceLabel.includes("earphone") ||
      deviceLabel.includes("earbuds") ||
      deviceLabel.includes("bluetooth")
    );
  }

  // 设备变化事件处理
  _onDeviceChange() {
    this._updateCurrentOutputDevice();
  }

  // 通知所有回调函数
  _notifyHeadphoneChange(isHeadphoneConnected) {
    this.headphoneChangeCallbacks.forEach((callback) => {
      callback(isHeadphoneConnected);
    });
  }
}
