// 上传文件名编码修正
//
// multer 解析 multipart 表单时，按历史包袱用 latin1 解码字段值，
// 中文文件名「以虎账户明细.xls」到手就成了「\u00c3\u00a4\u00c2\u00bb...xls」这种乱码。
// 凡是要落库或展示的文件名，都先过一遍这里。

/**
 * 把被当成 latin1 读的 UTF-8 片段还原回来。
 * 按「连续的 U+0080–U+00FF 字符」分段处理，因为日志摘要往往是
 * 正常中文 + 乱码文件名混在一起（「导入 \u00c3\u00a4... ：成功 18 条」），
 * 整串转换会把本来正常的中文也毁掉。UTF-8 多字节序列不会跨 ASCII 字符，
 * 所以按 ASCII 切段是安全的。
 */
export function repairMojibake(text) {
  if (!text || !/[\u0080-\u00ff]/.test(text)) return text
  return String(text).replace(/[\u0080-\u00ff]+/g, (run) => {
    const buf = Buffer.from(run, 'latin1')
    const decoded = buf.toString('utf8')
    // 解码出替换字符，说明这段不是被误读的 UTF-8，保持原样更安全
    if (decoded.includes('\ufffd')) return run
    // 往返校验：再编回去必须和原字节一致，否则不是这种乱码，别乱改
    if (!Buffer.from(decoded, 'utf8').equals(buf)) return run
    return decoded
  })
}

export const decodeFileName = repairMojibake
