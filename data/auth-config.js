/* 云同步配置。
   url / anonKey（新版叫 publishable key）是公开信息，会被打包进前端，可以提交；
   数据库密码、service_role key 属于机密，绝对不要写进这里。 */
window.ZZ_AUTH = {
  url: 'https://xsepwkfrqwzpcoddwstl.supabase.co',
  anonKey: 'sb_publishable_C_hNSmhnhHg-9lE-VwkD-A_1B-Q4Sd8',
  table: 'zz_sync'
};
