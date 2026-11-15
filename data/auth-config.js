/* 云同步配置（可选）。
   留空 = 不启用账号功能，所有数据只保存在本机浏览器里。
   想启用：在 https://supabase.com 建一个免费项目，把 Project URL 和 anon public key 填进来，
   再把「账号」面板里那段建表 SQL 在 SQL Editor 跑一遍即可。 */
window.ZZ_AUTH = {
  url: '',
  anonKey: '',
  table: 'zz_sync'
};
