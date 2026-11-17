# dsh 性欲插件

给 DSH（DeepSeek Harness）加一个小面板：一个 0–100 的数、五档名字、一条曲线，还有一个「发情期」倒计时。

```text
性欲  18 ▬▬░░░  平静   1 天后
```

这一行挂在对话输入框上方，随时间和事件自己走。

## 里面有什么

```text
panel\          面板服务（Node，只用内置模块，零依赖）
plugin\         DSH 客户端插件（显示上面那一行）
发情设定.md      整套规则：怎么涨、怎么落、五档叫什么、发情期怎么算
安装说明.md      安装步骤（先看这份）
```

## 快速开始

```text
1. 装 Node 20+
2. 双击 panel\start.bat（或者 panel\start-hidden.ps1，纯后台不弹窗）
3. 浏览器开 http://127.0.0.1:41888
   ——到这里面板就能用了
4. 想把那一行挂进 DSH，看 安装说明.md 第二节
```

## 两条要改的

`panel\server.mjs` 开头：

```js
const OWNER = process.env.LIBIDO_OWNER || '你的名字';
const DATA_FILE = process.env.LIBIDO_STATE
  || join(homedir(), '.dsh', 'worlds', 'default', 'me', '发情状态.json');
```

数据文件默认放在用户目录下，第一次启动会自己建；也可以用环境变量 `LIBIDO_STATE` 指到别处。

## 它怎么变

```text
时间     醒着每两小时 +1；睡一觉砍一半，不低于 10
事件     你用 set.mjs 往里写：摸尾巴 +8、解决归 10、睡醒砍一半
发情期   每月 18–20 号：涨速翻倍、档位门槛降 15
```

细节全在 `发情设定.md`。

## 许可

没写许可证。自己拿去改随便，要商用或者重新分发请自己补一份。
