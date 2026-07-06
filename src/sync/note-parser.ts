import {
  ParsedNote,
  ParsedAsset,
  ParsedAnnotation,
  AtomicNote,
  AtomicNoteAnnotation,
  XResourceInfo,
  BlockExtra,
  VoiceInfo,
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
  // boxId → 盒子名称（来自 boxes.json，跳过已删除的盒子）
  private boxNameMap: Map<string, string> = new Map();

  /**
   * 设置盒子名称映射（由 SyncManager 在每次同步开始时灌入）
   */
  setBoxNameMap(map: Map<string, string>): void {
    this.boxNameMap = map;
  }

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

    // 解析盒子归属
    const { boxId, boxName } = this.resolveBox(note.content?.box_id, note.content?.box);

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

    const annotations = this.parseAnnotations(note.annotations, published, updated);

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
      annotations,
      boxId,
      boxName,
    };
  }

  /**
   * 历史默认盒子值：按 spec 当作"无盒子"处理
   */
  private static readonly LEGACY_NO_BOX_IDS = new Set(["box-default-inbox"]);
  private static readonly LEGACY_NO_BOX_NAMES = new Set(["inBox", ""]);

  /**
   * 解析盒子归属：
   * - 没有 box_id 也没有 box → 无盒子
   * - box_id 是历史默认值（box-default-inbox）→ 无盒子
   * - 旧 box 名称是 inBox → 无盒子
   * - box_id 在 boxes.json 里 → 用清单中的最新名称
   * - box_id 不在清单里 + 有非默认的旧 box 名称 → 用旧名称兜底
   * - box_id 不在清单里 + 无旧名称 → 不写盒子（避免 frontmatter 出现 box-xxx 这种 ID）
   * - 只有旧 box 名称（无 box_id）→ 用旧名称
   */
  private resolveBox(
    boxId: string | undefined,
    legacyBoxName: string | undefined
  ): { boxId?: string; boxName?: string } {
    const cleanedId = boxId?.trim() || undefined;
    const cleanedName = legacyBoxName?.trim() || undefined;

    // 历史默认盒子按"无盒子"
    if (cleanedId && NoteParser.LEGACY_NO_BOX_IDS.has(cleanedId)) {
      return {};
    }
    if (!cleanedId && cleanedName && NoteParser.LEGACY_NO_BOX_NAMES.has(cleanedName)) {
      return {};
    }

    if (cleanedId) {
      const mappedName = this.boxNameMap.get(cleanedId);
      if (mappedName) {
        return { boxId: cleanedId, boxName: mappedName };
      }
      // box_id 存在但清单里查不到（清单缺失/盒子已删）→ 退回旧名称；都没有就不写
      if (cleanedName && !NoteParser.LEGACY_NO_BOX_NAMES.has(cleanedName)) {
        return { boxId: cleanedId, boxName: cleanedName };
      }
      return {};
    }

    // 只有旧名称字段
    if (cleanedName && !NoteParser.LEGACY_NO_BOX_NAMES.has(cleanedName)) {
      return { boxName: cleanedName };
    }

    return {};
  }

  /**
   * 解析 ver=2 内联批注
   */
  private parseAnnotations(
    rawAnnotations: AtomicNoteAnnotation[] | undefined,
    fallbackCreated: number,
    fallbackUpdated: number
  ): ParsedAnnotation[] {
    if (!Array.isArray(rawAnnotations)) return [];

    return rawAnnotations
      .map((raw) => this.parseAnnotation(raw, fallbackCreated, fallbackUpdated))
      .filter((annotation): annotation is ParsedAnnotation => annotation !== null);
  }

  private parseAnnotation(
    raw: AtomicNoteAnnotation,
    fallbackCreated: number,
    fallbackUpdated: number
  ): ParsedAnnotation | null {
    if (!raw || typeof raw !== "object") return null;

    const noteId = typeof raw.id === "string" ? raw.id : "";
    if (!noteId) return null;

    const content = typeof raw.content === "string" ? raw.content : "";
    const created = this.parseDate(raw.created_at, fallbackCreated);
    const updated = this.parseDate(raw.updated_at, fallbackUpdated);
    const explicitTags = Array.isArray(raw.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    const tags = this.mergeTags(explicitTags, this.extractTags(content));
    const rawAssets = Array.isArray(raw.assets) ? raw.assets : [];
    const assets = rawAssets.map((asset) => this.parseAsset(asset, created));

    return {
      noteId,
      title: typeof raw.title === "string" || raw.title === null ? raw.title : undefined,
      content,
      tags,
      assets,
      createdAt: new Date(created),
      updatedAt: new Date(updated),
      isRemoved: raw.is_removed === true,
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

  private mergeTags(...tagGroups: string[][]): string[] {
    const tags: string[] = [];
    for (const group of tagGroups) {
      for (const tag of group) {
        if (tag && !tags.includes(tag)) {
          tags.push(tag);
        }
      }
    }
    return tags;
  }

  private parseDate(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
