export const storyLogMessages = {
  'story_log.list.item': '{id}: {name} [{status}] {count} 条',
  'story_log.list.empty': '当前会话没有跑团日志。',
  'story_log.already_active':
    '当前已有未结束的跑团日志「{name}」，请先使用 .log end 关闭后再新建。',
  'story_log.new': '已创建并开启跑团日志「{name}」。',
  'story_log.not_recording': '当前会话无进行中的跑团日志。',
  'story_log.pause': '跑团日志「{name}」已暂停记录。',
  'story_log.not_found': '当前会话未开启跑团日志，请先使用 .log new <日志名> 创建。',
  'story_log.resume': '跑团日志「{name}」已恢复记录。',
  'story_log.halt': '跑团日志「{name}」已停止记录，未发起归档。',
  'story_log.delete_forbidden': '只有群主或骰主可以删除跑团日志。',
  'story_log.delete_not_found': '未找到指定跑团日志。使用 .log list 查看日志 ID 和名称。',
  'story_log.delete_active': '进行中或尚未关闭的跑团日志不能删除。',
  'story_log.delete': '跑团日志「{name}」已进入删除流程，删除收敛前不可下载。',
  'story_log.end': '跑团日志「{name}」已关闭，正在归档。归档完成后使用 .log export 获取下载链接。',
  'story_log.export_forbidden': '只有群主或骰主可以导出跑团日志。',
  'story_log.export_none': '当前群没有可导出的跑团日志。',
  'story_log.export_active': '跑团日志「{name}」仍在记录，请先使用 .log end 关闭。',
  'story_log.export_requested': '跑团日志「{name}」已提交归档，请稍后再次使用 .log export。',
  'story_log.export_pending': '跑团日志「{name}」正在归档，请稍后再次使用 .log export。',
  'story_log.export_unavailable': '跑团日志「{name}」归档暂不可用，请联系管理员。',
  'story_log.export_unconfigured':
    '归档已就绪，但下载地址尚未配置，请联系管理员设置 PUBLIC_BASE_URL。',
  'story_log.export': '跑团日志「{name}」已归档。下载链接（15 分钟内有效）：\n{url}',
  'story_log.stat.none': '当前群未开启跑团日志。使用 .log new <日志名> 开启。',
  'story_log.stat':
    '{status}跑团日志「{name}」：共 {itemCount} 条记录，其中 {rollCount} 条骰点；归档：{archiveStatus}',
  'story_log.archive.ready': '可下载（使用 .log get <名称或ID>）',
  'story_log.archive.none': '无',
  'story_log.help':
    '跑团日志管理：\n.log new <日志名> - 新建并开启日志\n.log on - 恢复记录\n.log pause/off - 暂停记录\n.log halt - 停止但不归档\n.log end - 关闭并归档日志\n.log list - 查看日志\n.log stat [名称或ID] - 查看统计\n.log get [名称或ID] - 获取归档下载链接\n.log del <名称或ID> - 删除已关闭日志',
} as const;

export const STORY_LOG_STATUS_LABELS: Readonly<Record<string, string>> = {
  new: '新建',
  recording: '记录中',
  paused: '已暂停',
  closed: '已关闭',
  deleting: '删除中',
  deleted: '已删除',
};
