# 第三方资产与许可说明

## 1. 字形字典（`extension/data/`）

- `glyphmeta.json` + `glyphdesc.bin.gz` 是**离线**用开源字体 Source Han Sans CN（思源黑体，Adobe 出品，SIL Open Font License 1.1）的字形轮廓生成的「字形指纹」表：
  - 32×32 位图 + 宽高/基线/测量值，用来把站点随机码位上显示的字形比回真字；
  - `glyphmeta.json` 的 `base` 字段记录了基准字体文件名（`SH1.000-SC-Normal.otf`，即思源黑体 Normal 字重），`grid`/`supersample`/`tol`/`upem` 是生成参数。
- 该数据**不含任何课程页面内容**：没有 URL、没有题目文本、没有账号信息（可用 `grep -c 'http\|chaoxing' extension/data/glyphmeta.json` 自查，结果为 0）。
- 由于属于该字体的衍生数据，请按 OFL-1.1 处理：许可全文见 [OFL-1.1.txt](OFL-1.1.txt)，版权行为
  `Copyright 2014-2025 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.`
- 仓库与 Release 包**都不包含字体文件本体**（`*.otf` / `*.ttf`）。

## 2. 站点字体样本

扩展里的「字体样本采集器」+ `tools/sample-server.mjs` 会把页面 `@font-face` 内嵌的字体落到本地 `_samples/`，仅用于本机比对本机渲染结果。

- 这些字体文件与采集结果**不入库、不随 Release 分发**（`_samples/`、`_fonts/` 已在 `.gitignore` 中忽略）。
- 仓库里的 `extension/data/` 只有上一条所述的指纹表，不含站点字体文件。

## 3. 图标

`extension/icons/*.png` 为项目自用的小图标（16/32/48/128）。

## 4. 代码

其余源码按仓库根目录的 [MIT](../LICENSE) 许可分发。
