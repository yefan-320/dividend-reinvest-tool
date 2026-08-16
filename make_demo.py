#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 demo-data.js：嵌入招行600036的K线收盘价 + 分红数据，供页面离线演示"""
import json

k = json.load(open('kline.json'))['data']['klines']
# 东财 kline 字段: 日期,开,收,高,低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率
closes = [[r.split(',')[0], float(r.split(',')[2])] for r in k]

d = json.load(open('dividends.json'))['result']['data']
divs = []
for r in d:
    ex = (r.get('EX_DIVIDEND_DATE') or '')[:10]
    dps = float(r.get('PRETAX_BONUS_RMB') or 0) / 10.0   # 元/股
    song = (r.get('BONUS_IT_RATIO') or 0)                 # 每10股送/转股数
    zhuan = (r.get('IT_RATIO') or 0)
    divs.append({
        'report': (r.get('REPORT_DATE') or '')[:10],
        'ex': ex,
        'record': (r.get('EQUITY_RECORD_DATE') or '')[:10],
        'dps': dps,
        'bonus': float(song or 0) / 10.0,       # v1.7.0: 送转合计（BONUS_IT_RATIO/10）
        'zhuanOnly': float(zhuan or 0) / 10.0,  # 仅展示：转增部分
    })
divs = [x for x in divs if x['ex']]  # 只要已除息的

out = {
    'code': '600036',
    'name': '招商银行',
    'closes': closes,
    'dividends': divs,
}
with open('demo-data.js', 'w', encoding='utf-8') as f:
    f.write('window.DEMO_DATA = ' + json.dumps(out, ensure_ascii=False) + ';\n')

print('closes:', len(closes), 'dividends:', len(divs))
print('首条K线:', closes[0], '末条:', closes[-1])
print('分红示例:', json.dumps(divs[0], ensure_ascii=False), json.dumps(divs[-1], ensure_ascii=False))
