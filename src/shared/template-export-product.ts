import {z} from "zod";
import type {ProductOperationDefinition} from "./product-operations";
import {TEMPLATE_CHANNELS,EXPORT_CHANNELS} from "./template-export-channels";
import {templateCaptureSchema,templateCommitSchema,templateReadSchema,templateImportSchema,offlineExportSchema,TEMPLATE_MAX_JSON_BYTES} from "./template-export-schemas";
export const templatePrepareImportSchema=z.object({dataBase64:z.string().max(Math.ceil(TEMPLATE_MAX_JSON_BYTES/3)*4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)}).strict();
export const TEMPLATE_OPERATION_SCHEMAS={"templates.list":z.undefined(),"templates.read":templateReadSchema,"templates.versions":z.string().uuid(),"templates.prepareCapture":templateCaptureSchema.safeExtend({sessionId:z.string().uuid().optional()}),"templates.commitCapture":templateCommitSchema,"templates.prepareImport":templatePrepareImportSchema,"templates.pickImport":z.undefined(),"templates.commitImport":templateImportSchema.omit({clientNonce:true}).extend({clientNonce:z.string().uuid().optional()}),"templates.export":templateReadSchema,"exports.save":offlineExportSchema};
export const TEMPLATE_PRODUCT_OPERATIONS:readonly ProductOperationDefinition[]=[
 {name:"templates.list",channel:TEMPLATE_CHANNELS.list,description:"列出当前授权的固定版本模板",effectClass:"read-local",interaction:"none"},
 {name:"templates.read",channel:TEMPLATE_CHANNELS.read,description:"读取模板固定版本，配置和资源正文仅传给当前模型",effectClass:"read-local",interaction:"none"},
 {name:"templates.versions",channel:TEMPLATE_CHANNELS.versions,description:"查看可访问的模板版本",effectClass:"read-local",interaction:"none"},
 {name:"templates.prepareCapture",channel:TEMPLATE_CHANNELS.prepareCapture,description:"按明确选择的 Bot、群成员、资料和文件暂存模板预览；不含密钥、Memory、历史、模型连接和授权",effectClass:"read-local",interaction:"none"},
 {name:"templates.commitCapture",channel:TEMPLATE_CHANNELS.commitCapture,description:"审核后保存模板新版本，expectedVersion 检测冲突",effectClass:"write-reversible",interaction:"none"},
 {name:"templates.prepareImport",channel:TEMPLATE_CHANNELS.prepareImport,description:"校验便携模板真实 JSON 字节并生成待审阅预览，不创建 Bot",effectClass:"read-local",interaction:"none"},
 {name:"templates.pickImport",channel:TEMPLATE_CHANNELS.pickImport,description:"通过本机文件选择器选择待审阅便携模板",effectClass:"read-local",interaction:"native"},
 {name:"templates.commitImport",channel:TEMPLATE_CHANNELS.commitImport,description:"按完整预览批准创建独立 Bot、群和资料；Skill 初始停用，不导入权限或登录态；TASK 不可用",effectClass:"write-reversible",interaction:"none"},
 {name:"templates.export",channel:TEMPLATE_CHANNELS.export,description:"通过本机保存对话框导出模板固定版本；不覆盖已有文件",effectClass:"write-reversible",interaction:"native"},
 {name:"exports.save",channel:EXPORT_CHANNELS.save,description:"仅导出明确选择的会话消息、资料固定版本、文件和媒体；本机保存 JSON 或可离线打开的 HTML，不上传",effectClass:"write-reversible",interaction:"native"},
];
