'use strict';
'require baseclass';
'require fs';

/*
 * 「状态 → 概览」页的一个区块：NSS 加速是否在工作。
 *
 * 概览页会把 /www/luci-static/resources/view/status/include/ 下的 *.js 按字母
 * 顺序全部加载，各自调 load() / render()。文件名前缀决定位置：11_cpu.js 是
 * 官方那个 CPU 区块，所以这里用 13_ 排在它后面。**不改任何官方文件**，
 * 升级 LuCI 不会把补丁冲掉。
 *
 * 用 13_ 而不是 12_：yduke/luci-app-nss 用的是 12_nss.js，两个包装在同一台
 * 机器上时（LibWrt 试编线就是这样）不能撞名，否则后装的会覆盖先装的。
 *
 * 两个后端只显示各自能拿到的信息：
 *   nss-wifi-drv → 就绪状态、无线卸载位图、vdev 数、硬件客户端数
 *   qca-nss-drv  → 各 NSS 核心的 1 秒平均负载
 * 两个都不在就返回 null，区块整块消失（非 NSS 平台不该看到一个空框）。
 */

var DBG = '/sys/kernel/debug/39000000.nss';
var QCA_STATS = '/sys/kernel/debug/qca-nss-drv/stats';

/*
 * 读一个 debugfs 文件，不存在返回 null。
 *
 * 不用 fs.read：本包的 ACL 只给了 /bin/sh 和 /bin/cat 的 exec 权限，没给
 * /sys 下的 file read；而且 rpcd 对符号链接会二次校验，/sys 里万一有
 * 链接就得再补一条白名单。用 sh 跑 `test -e && cat` 一条命令同时完成
 * 存在性判断和读取，ACL 不用动。
 */
function probe(path) {
	return fs.exec('/bin/sh', [ '-c', 'test -e ' + path + ' && cat ' + path ])
		.then(function(r) {
			return (r && r.code === 0) ? String(r.stdout || '') : null;
		}).catch(function() {
			return null;
		});
}

/* state 是一行 key=value，用空格分隔 */
function parseKv(text) {
	var out = {};
	var first = (text || '').trim().split('\n')[0] || '';

	first.trim().split(/\s+/).forEach(function(tok) {
		var i = tok.indexOf('=');

		if (i > 0)
			out[tok.slice(0, i)] = tok.slice(i + 1);
	});

	return out;
}

/* Core N: / Min Avg Max / "4% 5% 20%" 三行一组 */
function parseLoad(text) {
	var cores = [], cur = null;

	(text || '').split('\n').forEach(function(line) {
		var m = line.match(/^\s*Core\s+(\d+)\s*:/i);

		if (m) {
			cur = { id: +m[1], min: null, avg: null, max: null };
			cores.push(cur);
			return;
		}

		if (!cur)
			return;

		m = line.match(/^\s*(\d+)%\s+(\d+)%\s+(\d+)%/);

		if (m) {
			cur.min = +m[1];
			cur.avg = +m[2];
			cur.max = +m[3];
		}
	});

	return cores;
}

/* 卸载位图：1 = 内置 AHB，2 = 外挂 PCIe */
function unloadText(v) {
	var n = parseInt(v, 10) || 0, parts = [];

	if (n & 1) parts.push('AHB');
	if (n & 2) parts.push('PCIe');

	return parts.length ? parts.join(' + ') : '未卸载';
}

/* 和 11_cpu.js 一样的进度条，两个区块看起来才是一套 */
function progressbar(value, max) {
	var vn = parseInt(value) || 0, mn = parseInt(max) || 100,
	    pc = Math.floor((100 / mn) * vn);

	return E('div', {
		'class': 'cbi-progressbar',
		'title': '%s%% / %s%%'.format(vn, mn)
	}, E('div', { 'style': 'width:%.2f%%'.format(pc) }));
}

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '33%' }, [ label ]),
		E('td', { 'class': 'td left' }, [ value ])
	]);
}

return baseclass.extend({
	title: _('NSS 加速'),

	load: function() {
		return Promise.all([
			probe(DBG + '/state'),
			probe(QCA_STATS + '/cpu_load_ubi')
		]);
	},

	render: function(d) {
		var table = E('table', { 'class': 'table cpu' });

		/* ---- nss-wifi-drv ---- */
		if (d[0] != null) {
			var st = parseKv(d[0]);
			var ready = (st.ready === '1');

			table.appendChild(row('状态',
				E('span', { 'style': 'color:' + (ready ? '#43a047' : '#e53935') }, [
					ready ? '● 数据平面已就绪' : '● 未就绪'
				])));

			table.appendChild(row('Wi-Fi 卸载', unloadText(st.wlan)));

			if (st.vdevs != null || st.peers != null) {
				table.appendChild(row('虚拟接口 / 客户端',
					(st.vdevs != null ? st.vdevs : '?') + ' 个 vdev · ' +
					(st.peers != null ? st.peers : '?') + ' 台 peers'));
			}

			if (st.firmware != null)
				table.appendChild(row('固件线', String(st.firmware)));

			return table;
		}

		/* ---- qca-nss-drv ---- */
		var cores = parseLoad(d[1]);

		if (cores.length) {
			cores.forEach(function(core) {
				table.appendChild(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'width': '33%' },
						[ 'NSS Core ' + core.id ]),
					E('td', { 'class': 'td left' }, [
						(core.avg != null) ? progressbar(core.avg, 100) : '?',
						E('span', { 'style': 'margin-left:.5rem;opacity:.62;font-size:12px' },
							[ (core.min != null)
								? '最小 %d%% · 平均 %d%% · 峰值 %d%%'.format(core.min, core.avg, core.max)
								: '' ])
					])
				]));
			});

			return table;
		}

		/* 两套都不在：让这一节消失，而不是显示一个空表 */
		return null;
	}
});
