import { Plugin, TFile, Notice, PluginSettingTab, App, Setting } from "obsidian";
import { InboxSyncSettings, DEFAULT_SETTINGS } from "./types/settings";
import { SyncManager } from "./sync/sync-manager";
import { InboxSyncSettingTab } from "./ui/settings-tab";

/**
 * 同步状态枚举
 */
enum SyncStatus {
  IDLE = "idle",           // 空闲
  SYNCING = "syncing",     // 同步中
  SUCCESS = "success",     // 成功
  ERROR = "error",         // 失败
}

export default class InboxSyncPlugin extends Plugin {
  settings: InboxSyncSettings;
  syncManager: SyncManager;
  private syncIntervalId: number | null = null;
  private syncStatus: SyncStatus = SyncStatus.IDLE;
  private ribbonIcon: HTMLElement | null = null;

  async onload() {
    console.log("Loading inBox Sync plugin");

    // 加载设置
    await this.loadSettings();

    // 创建同步管理器（加保护，避免初始化异常导致插件无法启动）
    try {
      this.syncManager = new SyncManager(this.app, this.settings);
    } catch (error) {
      console.error("[inBox Sync] SyncManager 初始化失败:", error);
      new Notice(`inBox Sync 初始化失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 添加同步命令
    this.addCommand({
      id: "sync-inbox-now",
      name: "Sync now from inBox",
      callback: () => {
        this.syncNow();
      },
    });

    // 添加功能区按钮
    this.ribbonIcon = this.addRibbonIcon("refresh-cw", "Sync inBox", () => {
      this.syncNow();
    });
    this.updateRibbonIconStatus(SyncStatus.IDLE);

    // 添加设置页
    this.addSettingTab(new InboxSyncSettingTab(this.app, this));

    // 启动自动同步（如果已启用）
    if (this.settings.enableAutoSync && this.settings.syncInterval > 0) {
      this.startAutoSync();
    }
  }

  async onunload() {
    console.log("Unloading inBox Sync plugin");
    this.stopAutoSync();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.syncManager) {
      this.syncManager.updateSettings(this.settings);
    }

    // 更新自动同步
    if (this.settings.enableAutoSync && this.settings.syncInterval > 0) {
      this.startAutoSync();
    } else {
      this.stopAutoSync();
    }
  }

  /**
   * 立即执行同步
   */
  async syncNow() {
    // 检查配置完整性
    if (!this.validateSettings()) {
      return;
    }

    // 防止重复点击
    if (this.syncStatus === SyncStatus.SYNCING) {
      new Notice("Sync is already in progress...");
      return;
    }

    // 更新为同步中状态
    this.updateRibbonIconStatus(SyncStatus.SYNCING);
    const notice = new Notice("Starting sync from inBox...", 0);

    // 通知回调函数
    const notify = (message: string) => {
      notice.setMessage(message);
    };

    try {
      const stats = await this.syncManager.sync(notify);

      notice.hide();

      // 显示结果
      if (stats.failedNotes === 0 && stats.failedAssets === 0) {
        new Notice(
          `Sync complete: ${stats.newNotes} new, ${stats.updatedNotes} updated, ${stats.downloadedAssets} assets downloaded`,
          5000
        );
        this.updateRibbonIconStatus(SyncStatus.SUCCESS);
        // 3秒后恢复空闲状态
        setTimeout(() => this.updateRibbonIconStatus(SyncStatus.IDLE), 3000);
      } else {
        new Notice(
          `Sync finished with errors: ${stats.failedNotes} notes, ${stats.failedAssets} assets failed`,
          10000
        );
        console.error("Sync errors:", stats.errors);
        this.updateRibbonIconStatus(SyncStatus.ERROR);
        // 5秒后恢复空闲状态
        setTimeout(() => this.updateRibbonIconStatus(SyncStatus.IDLE), 5000);
      }
    } catch (error) {
      notice.hide();
      new Notice(`Sync failed: ${error.message}`, 10000);
      console.error("Sync error:", error);
      this.updateRibbonIconStatus(SyncStatus.ERROR);
      // 5秒后恢复空闲状态
      setTimeout(() => this.updateRibbonIconStatus(SyncStatus.IDLE), 5000);
    }
  }

  /**
   * 更新功能区图标状态
   */
  private updateRibbonIconStatus(status: SyncStatus) {
    if (!this.ribbonIcon) return;

    this.syncStatus = status;

    // 移除所有状态类
    this.ribbonIcon.removeClass("inbox-sync-idle");
    this.ribbonIcon.removeClass("inbox-sync-syncing");
    this.ribbonIcon.removeClass("inbox-sync-success");
    this.ribbonIcon.removeClass("inbox-sync-error");

    // 添加对应状态类
    const statusClass = `inbox-sync-${status}`;
    this.ribbonIcon.addClass(statusClass);

    // 更新提示文本
    const tooltipMap = {
      [SyncStatus.IDLE]: "Sync inBox",
      [SyncStatus.SYNCING]: "Syncing...",
      [SyncStatus.SUCCESS]: "Sync complete",
      [SyncStatus.ERROR]: "Sync failed - click to retry",
    };
    this.ribbonIcon.setAttribute("aria-label", tooltipMap[status]);
  }

  /**
   * 启动自动同步
   */
  private startAutoSync() {
    this.stopAutoSync();

    const intervalMs = this.settings.syncInterval * 60 * 1000;
    this.syncIntervalId = window.setTimeout(() => {
      this.syncNow();
      this.startAutoSync(); // 重新设置定时器
    }, intervalMs);
  }

  /**
   * 停止自动同步
   */
  private stopAutoSync() {
    if (this.syncIntervalId !== null) {
      window.clearTimeout(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  /**
   * 验证设置完整性
   */
  private validateSettings(): boolean {
    if (this.settings.storageType === "webdav") {
      if (!this.settings.webdavUrl || !this.settings.webdavUsername || !this.settings.webdavPassword) {
        new Notice("Please complete WebDAV configuration in settings");
        return false;
      }
    } else if (this.settings.storageType === "s3") {
      if (!this.settings.s3Endpoint || !this.settings.s3AccessKey || !this.settings.s3SecretKey || !this.settings.s3Bucket) {
        new Notice("Please complete S3 configuration in settings");
        return false;
      }
    }

    if (!this.settings.vaultFolderPath) {
      new Notice("Please set the vault folder path in settings");
      return false;
    }

    return true;
  }
}
