import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import InboxSyncPlugin from "../main";

// ========== i18n ==========
type LangKey = "zh" | "en";

function getLang(): LangKey {
  // 优先用 navigator.language（Electron 环境），其次 localStorage
  const lang = (navigator.language
    || window.localStorage.getItem("language")
    || "en");
  return lang.startsWith("zh") ? "zh" : "en";
}

type Translations = Record<string, { zh: string; en: string }>;

const t: Translations = {
  // 标题
  title: { zh: "inBox 同步设置", en: "inBox Sync Settings" },
  description: {
    zh: "配置你的 inBox 云存储，将笔记同步到 Obsidian Vault。",
    en: "Configure your inBox cloud storage to sync notes to your Obsidian vault.",
  },

  // 存储类型
  storageType: { zh: "存储类型", en: "Storage type" },
  storageTypeDesc: { zh: "选择云存储服务", en: "Choose your cloud storage provider" },
  s3Option: { zh: "S3 兼容存储", en: "S3 compatible" },

  // WebDAV
  webdavTitle: { zh: "WebDAV 配置", en: "WebDAV Configuration" },
  webdavUrl: { zh: "服务器地址", en: "Server URL" },
  webdavUrlDesc: { zh: "WebDAV 服务器地址（如 https://dav.example.com）", en: "WebDAV server URL (e.g., https://dav.example.com)" },
  webdavUsername: { zh: "用户名", en: "Username" },
  webdavUsernameDesc: { zh: "WebDAV 登录用户名", en: "WebDAV login username" },
  webdavPassword: { zh: "授权密码", en: "Authorization password" },
  webdavPasswordDesc: { zh: "WebDAV 授权密码（第三方应用专用密码）", en: "WebDAV app-specific authorization password" },

  // S3
  s3Title: { zh: "S3 配置", en: "S3 Configuration" },
  s3Endpoint: { zh: "Endpoint", en: "Endpoint" },
  s3EndpointDesc: { zh: "S3 兼容服务的访问地址", en: "S3-compatible service endpoint URL" },
  s3AccessKey: { zh: "Access Key", en: "Access Key" },
  s3AccessKeyDesc: { zh: "S3 访问密钥", en: "S3 access key" },
  s3SecretKey: { zh: "Secret Key", en: "Secret Key" },
  s3SecretKeyDesc: { zh: "S3 密钥", en: "S3 secret key" },
  s3Bucket: { zh: "Bucket", en: "Bucket" },
  s3BucketDesc: { zh: "S3 存储桶名称", en: "S3 bucket name" },
  s3Region: { zh: "Region", en: "Region" },
  s3RegionDesc: { zh: "S3 区域（如 cn-beijing）", en: "S3 region (e.g., us-east-1)" },

  // 同步设置
  syncTitle: { zh: "同步设置", en: "Sync Settings" },
  vaultFolder: { zh: "本地存储路径", en: "Vault folder path" },
  vaultFolderDesc: { zh: "笔记在 Vault 中的存储文件夹", en: "The folder in your vault where synced notes will be stored" },
  autoSync: { zh: "自动同步", en: "Auto sync" },
  autoSyncDesc: { zh: "定时自动同步笔记", en: "Automatically sync notes at regular intervals" },
  syncInterval: { zh: "同步间隔（分钟）", en: "Sync interval (minutes)" },
  syncIntervalDesc: { zh: "自动同步的时间间隔（需开启自动同步）", en: "How often to auto sync (requires auto sync enabled)" },

  // 高级选项
  advancedTitle: { zh: "高级选项", en: "Advanced Options" },
  frontmatterTags: { zh: "Frontmatter 标签", en: "Frontmatter tags" },
  frontmatterTagsDesc: { zh: "从笔记内容中提取标签并写入 YAML frontmatter", en: "Extract tags from note content and add to YAML frontmatter" },
  preserveContentTags: { zh: "保留正文标签", en: "Preserve content tags" },
  preserveContentTagsDesc: { zh: "在笔记正文中保留 #标签（同时也会写入 frontmatter）", en: "Keep #tags in note content (also written to frontmatter)" },
  conflictResolution: { zh: "冲突处理策略", en: "Conflict resolution" },
  conflictResolutionDesc: { zh: "遇到 Vault 中已存在的笔记时的处理方式", en: "How to handle notes that already exist in your vault" },
  conflictSkip: { zh: "跳过（保留已有笔记）", en: "Skip (keep existing)" },
  conflictOverwrite: { zh: "覆盖（用新笔记替换）", en: "Overwrite (replace with new)" },
  conflictRename: { zh: "重命名（保留两者）", en: "Rename (keep both)" },

  // 测试连接
  testConnection: { zh: "测试连接", en: "Test connection" },
  testConnectionDesc: { zh: "验证云存储配置是否正确", en: "Verify your cloud storage credentials" },
  testing: { zh: "测试中...", en: "Testing..." },
  connectionSuccess: { zh: "✓ 连接成功！配置正确。", en: "✓ Connection successful! Settings are correct." },
  connectionFailed: { zh: "✗ 连接失败：", en: "✗ Connection failed: " },
  noticeSuccess: { zh: "inBox Sync: 连接成功！", en: "inBox Sync: Connection successful!" },
  noticeFailed: { zh: "inBox Sync: 连接失败 - ", en: "inBox Sync: Connection failed - " },
};

function i18n(key: string): string {
  const lang = getLang();
  return t[key]?.[lang] ?? t[key]?.["en"] ?? key;
}

/**
 * 插件设置页面
 */
export class InboxSyncSettingTab extends PluginSettingTab {
  plugin: InboxSyncPlugin;
  private testingConnection = false;

  constructor(app: App, plugin: InboxSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // 标题和说明
    new Setting(containerEl).setName(i18n("title")).setHeading();
    containerEl.createEl("p", { text: i18n("description") });

    // ========== 云存储配置 ==========
    new Setting(containerEl)
      .setName(i18n("storageType"))
      .setDesc(i18n("storageTypeDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("webdav", "WebDAV")
          .addOption("s3", i18n("s3Option"))
          .setValue(this.plugin.settings.storageType)
          .onChange(async (value: "webdav" | "s3") => {
            this.plugin.settings.storageType = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    // ========== WebDAV 配置 ==========
    if (this.plugin.settings.storageType === "webdav") {
      new Setting(containerEl).setName(i18n("webdavTitle")).setHeading();

      new Setting(containerEl)
        .setName(i18n("webdavUrl"))
        .setDesc(i18n("webdavUrlDesc"))
        .addText((text) =>
          text
            .setPlaceholder("https://dav.example.com")
            .setValue(this.plugin.settings.webdavUrl)
            .onChange(async (value) => {
              this.plugin.settings.webdavUrl = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName(i18n("webdavUsername"))
        .setDesc(i18n("webdavUsernameDesc"))
        .addText((text) =>
          text
            .setPlaceholder("username")
            .setValue(this.plugin.settings.webdavUsername)
            .onChange(async (value) => {
              this.plugin.settings.webdavUsername = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName(i18n("webdavPassword"))
        .setDesc(i18n("webdavPasswordDesc"))
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("••••••••")
            .setValue(this.plugin.settings.webdavPassword)
            .onChange(async (value) => {
              this.plugin.settings.webdavPassword = value;
              await this.plugin.saveSettings();
            });
        });

      this.addTestConnectionButton(containerEl);
    }

    // ========== S3 配置 ==========
    if (this.plugin.settings.storageType === "s3") {
      new Setting(containerEl).setName(i18n("s3Title")).setHeading();

      new Setting(containerEl)
        .setName(i18n("s3Endpoint"))
        .setDesc(i18n("s3EndpointDesc"))
        .addText((text) =>
          text
            .setPlaceholder("https://s3.example.com")
            .setValue(this.plugin.settings.s3Endpoint)
            .onChange(async (value) => {
              this.plugin.settings.s3Endpoint = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName(i18n("s3AccessKey"))
        .setDesc(i18n("s3AccessKeyDesc"))
        .addText((text) =>
          text
            .setPlaceholder("access-key")
            .setValue(this.plugin.settings.s3AccessKey)
            .onChange(async (value) => {
              this.plugin.settings.s3AccessKey = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName(i18n("s3SecretKey"))
        .setDesc(i18n("s3SecretKeyDesc"))
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("••••••••")
            .setValue(this.plugin.settings.s3SecretKey)
            .onChange(async (value) => {
              this.plugin.settings.s3SecretKey = value;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName(i18n("s3Bucket"))
        .setDesc(i18n("s3BucketDesc"))
        .addText((text) =>
          text
            .setPlaceholder("my-bucket")
            .setValue(this.plugin.settings.s3Bucket)
            .onChange(async (value) => {
              this.plugin.settings.s3Bucket = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName(i18n("s3Region"))
        .setDesc(i18n("s3RegionDesc"))
        .addText((text) =>
          text
            .setPlaceholder("us-east-1")
            .setValue(this.plugin.settings.s3Region)
            .onChange(async (value) => {
              this.plugin.settings.s3Region = value;
              await this.plugin.saveSettings();
            })
        );

      this.addTestConnectionButton(containerEl);
    }

    // ========== 同步设置 ==========
    new Setting(containerEl).setName(i18n("syncTitle")).setHeading();

    new Setting(containerEl)
      .setName(i18n("vaultFolder"))
      .setDesc(i18n("vaultFolderDesc"))
      .addText((text) =>
        text
          .setPlaceholder("inBox")
          .setValue(this.plugin.settings.vaultFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.vaultFolderPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(i18n("autoSync"))
      .setDesc(i18n("autoSyncDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoSync)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoSync = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(i18n("syncInterval"))
      .setDesc(i18n("syncIntervalDesc"))
      .addSlider((slider) =>
        slider
          .setLimits(5, 120, 5)
          .setValue(this.plugin.settings.syncInterval)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = value;
            await this.plugin.saveSettings();
          })
      );

    // ========== 高级选项 ==========
    new Setting(containerEl).setName(i18n("advancedTitle")).setHeading();

    new Setting(containerEl)
      .setName(i18n("frontmatterTags"))
      .setDesc(i18n("frontmatterTagsDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableFrontmatterTags)
          .onChange(async (value) => {
            this.plugin.settings.enableFrontmatterTags = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(i18n("preserveContentTags"))
      .setDesc(i18n("preserveContentTagsDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.preserveContentTags)
          .onChange(async (value) => {
            this.plugin.settings.preserveContentTags = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(i18n("conflictResolution"))
      .setDesc(i18n("conflictResolutionDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("skip", i18n("conflictSkip"))
          .addOption("overwrite", i18n("conflictOverwrite"))
          .addOption("rename", i18n("conflictRename"))
          .setValue(this.plugin.settings.conflictResolution)
          .onChange(async (value: "skip" | "overwrite" | "rename") => {
            this.plugin.settings.conflictResolution = value;
            await this.plugin.saveSettings();
          })
      );
  }

  /**
   * 添加测试连接按钮
   */
  private addTestConnectionButton(containerEl: HTMLElement): void {
    const statusEl = containerEl.createEl("div", {
      cls: "inbox-connection-status",
    });

    new Setting(containerEl)
      .setName(i18n("testConnection"))
      .setDesc(i18n("testConnectionDesc"))
      .addButton((button) =>
        button
          .setButtonText(i18n("testConnection"))
          .setDisabled(this.testingConnection)
          .onClick(async () => {
            if (this.testingConnection) return;

            this.testingConnection = true;
            button.setButtonText(i18n("testing"));
            button.setDisabled(true);
            statusEl.textContent = "";
            statusEl.className = "inbox-connection-status";

            try {
              this.plugin.syncManager.updateSettings(this.plugin.settings);
              const result = await this.plugin.syncManager.testConnection();

              if (result.success) {
                statusEl.textContent = i18n("connectionSuccess");
                statusEl.className = "inbox-connection-status inbox-status-success";
                new Notice(i18n("noticeSuccess"));
              } else {
                statusEl.textContent = i18n("connectionFailed") + result.error;
                statusEl.className = "inbox-connection-status inbox-status-error";
                new Notice(i18n("noticeFailed") + result.error);
              }
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              statusEl.textContent = i18n("connectionFailed") + errorMsg;
              statusEl.className = "inbox-connection-status inbox-status-error";
              new Notice(i18n("noticeFailed") + errorMsg);
            } finally {
              this.testingConnection = false;
              button.setButtonText(i18n("testConnection"));
              button.setDisabled(false);
            }
          })
      );

    statusEl.textContent = "";
  }
}
