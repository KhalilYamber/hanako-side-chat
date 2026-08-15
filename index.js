// side-chat 插件入口
// 职责：初始化单例状态（会话存储、主对话上下文采集器），注册卸载清理。
// 主对话上下文采集采用懒加载：widget 首次打开或首次发消息时 ensure()。

export default class SideChatPlugin {
  async onload() {
    const { log, config, dataDir } = this.ctx;
    const g = globalThis;

    if (!g.__sideChat || typeof g.__sideChat !== 'object') {
      g.__sideChat = {};
    }
    g.__sideChat.ctx = this.ctx;
    g.__sideChat.dataDir = dataDir;
    g.__sideChat.cfg = config;
    g.__sideChat.bus = this.ctx.bus;

    this.register(() => {
      g.__sideChat = null;
    });

    log?.info?.('[side-chat] loaded');
  }
}
