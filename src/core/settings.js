// 用户设置与首次风险确认（PRD §4、§11）。只写 'settings' 和 'riskAck' 键。

import { validateConfig } from './config.js';

/** 风险说明版本。说明内容变化时更新版本号，用户需重新确认。 */
export const RISK_NOTICE_VERSION = '2026-11-27';

export const RISK_NOTICE = Object.freeze([
  '本插件与 BOSS 直聘无隶属或合作关系。',
  '自动化操作可能导致账号受限或封禁；额度和间隔只是本插件的默认值，不代表平台允许或保证账号安全。',
  '插件只点击「立即沟通」，以你在平台设置的默认招呼语发起沟通，不发送附件简历，也不回复 HR。',
  '遇到验证码、访问限制或登录失效时插件会暂停，需要你在平台上自行处理；插件不会绕过这些限制。',
  '所有记录只保存在本机浏览器中，不上传到任何服务器。',
  '使用前请阅读并遵守 BOSS 直聘的协议与规则，并自行承担使用后果。',
]);

export function createSettingsStore({ storage, now = () => Date.now() }) {
  return {
    /** 读取已保存的设置（原始输入）。没有保存过时返回 null。 */
    async getConfig() {
      return (await storage.get(['settings'])).settings ?? null;
    },

    /**
     * 校验并保存设置。校验失败时不保存，返回错误，避免用无效配置开始任务。
     * @returns {Promise<{ok: boolean, errors: object[], config: object}>}
     */
    async saveConfig(input) {
      const result = validateConfig(input);
      if (result.ok) await storage.set({ settings: result.config });
      return result;
    },

    async getRiskAck() {
      const ack = (await storage.get(['riskAck'])).riskAck ?? null;
      return { acknowledged: ack?.version === RISK_NOTICE_VERSION, ack, version: RISK_NOTICE_VERSION };
    },

    async ackRisk(version) {
      if (version !== RISK_NOTICE_VERSION) throw new Error('风险说明版本不一致，请重新阅读');
      const ack = { version, at: now() };
      await storage.set({ riskAck: ack });
      return ack;
    },
  };
}
