/**
 * 将 Markdown 文本转换为适合系统通知展示的纯文本。
 *
 * 处理顺序很重要：先处理块级元素再处理行内元素，
 * 避免正则互相干扰。
 */
export function stripMarkdown(text: string): string {
  return text
    // 围栏代码块 ```...``` → 保留内容，去掉标记行
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    // 行内代码 `code` → code
    .replace(/`([^`\n]+)`/g, "$1")
    // 标题 # / ## / ### → 去掉 # 前缀
    .replace(/^#{1,6}\s+/gm, "")
    // 加粗 **text** / __text__ → text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    // 斜体 *text* / _text_ → text
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    // 删除线 ~~text~~ → text
    .replace(/~~([^~\n]+)~~/g, "$1")
    // 图片 ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 链接 [text](url) → text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 引用块 > → 去掉前缀
    .replace(/^>\s*/gm, "")
    // 无序列表 - / * / + → 去掉前缀
    .replace(/^[-*+]\s+/gm, "")
    // 有序列表 1. → 去掉前缀
    .replace(/^\d+\.\s+/gm, "")
    // 水平分隔线 --- / *** / ___ → 空格
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // 合并连续空白（换行转空格）
    .replace(/\s+/g, " ")
    .trim();
}
