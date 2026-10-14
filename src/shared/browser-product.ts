import type { ProductOperationDefinition } from "./product-operations";
import { BROWSER_CHANNELS, COMPUTER_CHANNELS, PREVIEW_CHANNELS } from "./browser-channels";
import type { z } from "zod";
import {
  browserScopeSchema, browserEpochSchema, browserMutationSchema, browserPageMutationSchema, browserNavigateSchema, browserObserveSchema,
  browserReadSchema, browserClickSchema, browserTypeSchema, browserKeySchema, browserScrollSchema, browserNewTabSchema, browserDownloadInputSchema,
  computerControlSchema, computerVncTicketSchema, computerScreenshotSchema, computerClickSchema, computerTypeSchema, computerScrollSchema, previewOpenSchema, previewCloseSchema,
} from "./browser-schemas";
export { BROWSER_CHANNELS, COMPUTER_CHANNELS, PREVIEW_CHANNELS } from "./browser-channels";
const scope = { sessionId: true, executorBotId: true } as const;
export const BROWSER_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "browser.get": browserScopeSchema.partial(scope).optional(), "browser.start": browserMutationSchema.omit({ clientNonce: true }).partial(scope).optional(), "browser.stop": browserMutationSchema.omit({ clientNonce: true }).partial(scope).optional(),
  "browser.tabs": browserEpochSchema.partial(scope), "browser.newTab": browserNewTabSchema.omit({ clientNonce: true }).partial(scope), "browser.closeTab": browserPageMutationSchema.omit({ clientNonce: true }).partial(scope),
  "browser.navigate": browserNavigateSchema.omit({ clientNonce: true }).partial(scope), "browser.read": browserReadSchema.partial(scope), "browser.observe": browserObserveSchema.partial(scope),
  "browser.click": browserClickSchema.omit({ clientNonce: true }).partial(scope), "browser.type": browserTypeSchema.omit({ clientNonce: true }).partial(scope), "browser.key": browserKeySchema.omit({ clientNonce: true }).partial(scope), "browser.scroll": browserScrollSchema.omit({ clientNonce: true }).partial(scope),
  "browser.downloads": browserEpochSchema.partial(scope), "browser.download": browserDownloadInputSchema.omit({ clientNonce: true }).partial(scope), "computer.view": browserScopeSchema.partial(scope).optional(),
  "computer.screenshot": computerScreenshotSchema.partial(scope), "computer.click": computerClickSchema.omit({ clientNonce: true }).partial(scope), "computer.type": computerTypeSchema.omit({ clientNonce: true }).partial(scope),
  "computer.key": browserKeySchema.omit({ clientNonce: true }).partial(scope), "computer.scroll": computerScrollSchema.omit({ clientNonce: true }).partial(scope),
  "computer.takeover": computerControlSchema.omit({ clientNonce: true }).partial(scope), "computer.returnControl": computerControlSchema.omit({ clientNonce: true }).partial(scope), "computer.vncTicket": computerVncTicketSchema.omit({ clientNonce: true }).partial(scope),
  "preview.list": browserEpochSchema.partial(scope), "preview.open": previewOpenSchema.omit({ clientNonce: true }).partial(scope), "preview.close": previewCloseSchema.omit({ clientNonce: true }).partial(scope),
};
const descriptions: Record<string, string> = {
  "browser.get": "读取当前隔离浏览器状态与控制 epoch，不返回登录资料或控制密钥", "browser.start": "启动本会话执行者的隔离浏览器与桌面伴随环境", "browser.stop": "停止当前浏览器伴随环境，保留独立 profile",
  "browser.tabs": "读取当前授权浏览器的真实页面列表", "browser.newTab": "在当前浏览器打开新页面", "browser.closeTab": "关闭指定真实页面", "browser.navigate": "导航指定页面到 HTTP(S) 地址",
  "browser.read": "按范围读取真实页面文本并登记当前观察", "browser.observe": "观察真实页面文本与可操作元素引用", "browser.click": "基于当前 epoch 与新鲜观察点击指定元素",
  "browser.type": "基于当前观察输入文本，元信息不能授权脚本执行", "browser.key": "在当前已观察页面发送按键", "browser.scroll": "滚动当前已观察页面", "browser.downloads": "列出本浏览器已完成的真实下载", "browser.download": "由用户选择位置保存真实下载字节",
  "computer.view": "读取电脑资源的控制归属、连接状态与 epoch", "computer.screenshot": "获取真实屏幕像素并登记有界图片引用，路径文字不计为视觉能力", "computer.click": "基于同一资源的新鲜屏幕观察点击坐标",
  "computer.type": "在已观察的隔离电脑输入文本", "computer.key": "在已观察的隔离电脑发送按键", "computer.scroll": "在已观察的隔离电脑滚动", "preview.list": "列出当前环境已登记的服务预览",
  "computer.takeover": "请求用户在电脑面板明确接管；AI调用仅返回 waiting_user，不自行改变控制权", "computer.returnControl": "请求用户在电脑面板明确归还；AI调用仅返回 waiting_user，归还后必须重新观察",
  "computer.vncTicket": "只为可信本机UI建立当前epoch连接；AI调用不返回连接能力、令牌或管理地址",
  "preview.open": "打开已核验后台服务端口的真实预览", "preview.close": "关闭当前登记的服务预览",
};
const reads = new Set(["browser.get", "browser.tabs", "browser.read", "browser.observe", "browser.downloads", "computer.view", "computer.screenshot", "preview.list"]);
/** Human controls remain discoverable; the host must return waiting_user for model callers. */
export const BROWSER_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = [
  ...Object.entries(BROWSER_CHANNELS).map(([method, channel]) => ({ name: `browser.${method}`, channel })),
  ...Object.entries(COMPUTER_CHANNELS).map(([method, channel]) => ({ name: `computer.${method}`, channel })),
  ...Object.entries(PREVIEW_CHANNELS).map(([method, channel]) => ({ name: `preview.${method}`, channel })),
].map(({ name, channel }) => ({ name, channel, description: descriptions[name]!, effectClass: reads.has(name) ? "read-local" : "irreversible", interaction: name === "browser.download" || name === "computer.vncTicket" ? "native" : "none" }));
