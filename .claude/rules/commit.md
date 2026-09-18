# Commit Message 规范

本项目遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范。

## 格式

```
<type>(<scope>): <subject>
```

## Type 枚举

| Type | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `style` | 代码格式（不影响功能） |
| `refactor` | 重构 |
| `perf` | 性能优化 |
| `test` | 测试 |
| `build` | 构建/依赖 |
| `ci` | CI 配置 |
| `chore` | 其他杂项 |
| `revert` | 回滚 |

## 规则

- type 必须小写
- subject 不得为空
- subject 末尾不加句号
- header 总长度不超过 100 字符
- body 每行不超过 200 字符

## 示例

```
feat(agent): add streaming response support
fix(config): strip ANSI escape codes from interactive input
docs: add Chinese README translation
refactor(session): replace require() with ESM imports
```
