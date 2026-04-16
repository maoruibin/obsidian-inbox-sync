import {
  ParsedNote,
  ParsedAsset,
  AtomicNote,
  XResourceInfo,
  BlockExtra,
  VoiceInfo,
  formatDate,
  formatMonth,
  getResourceType,
  ResourceType,
  getCreatedAt,
  getUpdatedAt,
  getIsRemoved,
  getParentId,
} from "../types/inbox";

/**
 * 笔记解析器
 * 解析 inBox 原子笔记格式（兼容 Android snake_case）
 */
export class NoteParser {
  /**
   * 解析原子笔记数据
   */
  parse(note: AtomicNote): ParsedNote {
    const published = getCreatedAt(note.meta);
    const updated = getUpdatedAt(note.meta);
    const isRemoved = getIsRemoved(note.flags);

    // 解析图片 JSON（处理双重编码）
    const images: XResourceInfo[] = this.parseImageJson(note.imageJson);

    // 解析额外信息（录音等）
    const extra: BlockExtra = this.parseExtra(note.extra);

    // 从 content.assets 提取额外资源（Android 可能将资源存在这里）
    const contentAssets = note.content?.assets || [];
    const allImages = [...images, ...contentAssets];

    // 提取标签
    const content = note.content?.content || "";
    const tags = this.extractTags(content);

    // 分类资源
    const parsedImages: ParsedAsset[] = [];
    const parsedVideos: ParsedAsset[] = [];
    const parsedAudios: ParsedAsset[] = [];
    const parsedAttachments: ParsedAsset[] = [];

    // 处理所有资源
    for (const image of allImages) {
      const asset = this.parseAsset(image, published);
      const type = getResourceType(image.mimeType);

      switch (type) {
        case ResourceType.IMAGE:
          parsedImages.push(asset);
          break;
        case ResourceType.VIDEO:
          parsedVideos.push(asset);
          break;
        case ResourceType.AUDIO:
          parsedAudios.push(asset);
          break;
        default:
          parsedAttachments.push(asset);
      }
    }

    // 处理录音
    if (extra.voice) {
      const voiceAsset = this.parseVoiceAsset(extra.voice, published);
      parsedAudios.push(voiceAsset);
    }

    return {
      blockId: note.blockId || 0,
      noteId: note.id || `note-${note.blockId}`,
      title: note.content?.title || "Untitled",
      content,
      tags,
      images: parsedImages,
      videos: parsedVideos,
      audios: parsedAudios,
      attachments: parsedAttachments,
      createdAt: new Date(published),
      updatedAt: new Date(updated),
      published,
      isRemoved,
      parentId: getParentId(note) || undefined,
    };
  }

  /**
   * 解析 imageJson 字段
   * 处理双重编码：Android 可能将 JSON 数组再次 JSON.stringify
   */
  private parseImageJson(imageJson: string): XResourceInfo[] {
    if (!imageJson) return [];

    try {
      // 第一次解析
      let parsed: unknown = JSON.parse(imageJson);

      // 检查是否仍然是 JSON 字符串（双重编码）
      if (typeof parsed === "string") {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          // 第二次解析失败，返回空
          return [];
        }
      }

      // 确保是数组
      if (Array.isArray(parsed)) {
        return parsed as XResourceInfo[];
      }

      return [];
    } catch (e) {
      console.warn("[NoteParser] imageJson 解析失败:", e);
      return [];
    }
  }

  /**
   * 解析 extra 字段
   */
  private parseExtra(extra: string | undefined): BlockExtra {
    if (!extra) return {};

    try {
      // 尝试直接解析
      return JSON.parse(extra);
    } catch {
      // 尝试处理双重编码
      try {
        const parsed = JSON.parse(extra);
        if (typeof parsed === "string") {
          return JSON.parse(parsed);
        }
        return parsed as BlockExtra;
      } catch {
        return {};
      }
    }
  }

  /**
   * 解析单个资源
   */
  private parseAsset(resource: XResourceInfo, timestamp: number): ParsedAsset {
    // 兼容 mimeType / mime_type / type
    const mimeType = resource.mimeType || resource.mime_type;
    const type = getResourceType(mimeType, resource.type || resource.resourceType);
    const dateStr = formatDate(timestamp);
    const monthStr = formatMonth(timestamp);

    // 确定远程路径（优先 cloudUrl > remoteUrl > path > src）
    let remotePath = "";
    let remoteUrl = "";

    const cloudUrl = resource.cloudUrl || resource.remoteUrl;
    if (cloudUrl) {
      remoteUrl = cloudUrl;
      try {
        const url = new URL(cloudUrl);
        remotePath = url.pathname;
      } catch {
        remotePath = resource.path || resource.src || "";
      }
    } else if (resource.path) {
      // Android atomicNote 格式：path 是相对路径如 "assets/images/img-xxx.png"
      remotePath = resource.path;
      remoteUrl = resource.path;
    } else if (resource.src) {
      remoteUrl = resource.src;
      remotePath = resource.src;
    } else {
      remotePath = "";
    }

    // 生成本地路径
    const fileName = this.extractFileName(remotePath);
    const localPath = this.getLocalPath(type, fileName);

    return {
      remoteUrl,
      remotePath,
      localPath,
      mimeType: mimeType || "",
      type,
      width: resource.width,
      height: resource.height,
      size: resource.size || resource.length || 0,
    };
  }

  /**
   * 解析录音资源
   */
  private parseVoiceAsset(voice: VoiceInfo, timestamp: number): ParsedAsset {
    const fileName = this.extractFileName(voice.path);

    return {
      remoteUrl: voice.remoteUrl || voice.path,
      remotePath: voice.path,
      localPath: `assets/audios/${fileName}`,
      mimeType: "audio/mpeg",
      type: ResourceType.AUDIO,
      duration: voice.duration,
      size: voice.size,
    };
  }

  /**
   * 从路径提取文件名
   */
  private extractFileName(path: string): string {
    return path.split("/").pop() || "unknown";
  }

  /**
   * 获取资源本地路径
   */
  private getLocalPath(
    type: ResourceType,
    fileName: string
  ): string {
    switch (type) {
      case ResourceType.IMAGE:
        return `assets/images/${fileName}`;
      case ResourceType.VIDEO:
        return `assets/videos/${fileName}`;
      case ResourceType.AUDIO:
        return `assets/audios/${fileName}`;
      default:
        return `assets/attachments/${fileName}`;
    }
  }

  /**
   * 从内容提取标签
   * 支持 #tag 和 #tag/subtag 格式
   */
  private extractTags(content: string): string[] {
    const tags: string[] = [];
    const tagRegex = /#([\p{L}\p{N}_/]+)/gu;

    let match;
    while ((match = tagRegex.exec(content)) !== null) {
      const tag = match[1];
      if (tag && !tags.includes(tag)) {
        tags.push(tag);
      }
    }

    return tags;
  }
}
