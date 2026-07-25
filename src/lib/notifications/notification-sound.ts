/**
 * 通知提示音工具
 *
 * 使用 Web Audio API 生成轻量级提示音，用于应用内通知（Toast）。
 * OS 原生通知使用系统自带提示音（通过 sendNotification 的 sound 选项），
 * 此模块仅为应用内通知场景提供声音反馈。
 *
 * 单例 AudioContext，惰性初始化，不产生外部依赖。
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/**
 * 播放一个简短的通知提示音（约 200ms）。
 *
 * 使用两个频率（A5 → C#6）的正弦波，模拟轻柔的上行提示音。
 * 音量从 0.15 快速衰减至静音，确保不刺耳。
 */
export async function playNotificationSound(): Promise<void> {
  try {
    const ctx = getAudioContext();

    // AudioContext 可能因浏览器自动播放策略被挂起，必须等待恢复完成
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "sine";
    // A5 (880Hz) → C#6 (~1109Hz)，上行小三度，清脆友好
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1108.73, now + 0.1);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    osc.start(now);
    osc.stop(now + 0.25);
  } catch {
    // Web Audio API 不可用时静默失败
  }
}
