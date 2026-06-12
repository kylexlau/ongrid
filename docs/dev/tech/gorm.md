# GORM & MySQL / SQLite

> 业务数据持久化用 [GORM](https://gorm.io)（Go 最流行的 ORM）+ MySQL
> （本地可切 SQLite）。Schema 由启动时 `AutoMigrate` 对账，没有 migration 文件流程。

## 为什么是 GORM + AutoMigrate

自托管产品的安装体验优先：用户 `install.sh` 一把起，升级 = 换镜像重启，
不能要求用户跑 migration 工具。代价是 schema 演进受 AutoMigrate 能力约束（见下）。

## 核心概念

### 1. 模型映射

```go
type AlertRule struct {
    ID        uint64    `gorm:"primaryKey"`
    OrgID     uint64    `gorm:"index"`
    Name      string    `gorm:"size:256"`
    Spec      string    `gorm:"type:text"`
    CreatedAt time.Time
    UpdatedAt time.Time // GORM 自动维护 CreatedAt/UpdatedAt
}
```

表名 = 结构体复数蛇形（`alert_rules`）；列名 = 字段蛇形。

### 2. CRUD 与查询

```go
db.WithContext(ctx).Create(&rule)
db.WithContext(ctx).First(&rule, id)                  // 主键查；找不到 → gorm.ErrRecordNotFound
db.WithContext(ctx).Where("org_id = ?", orgID).Find(&rules)
db.WithContext(ctx).Model(&rule).Updates(map[string]any{"name": n})
```

- **永远 `WithContext(ctx)`**——超时/取消才能传播；
- 条件一律 `?` 占位（红线：SQL 禁止字符串拼接）；
- `ErrRecordNotFound` 在 data 层翻译成 `errs.ErrNotFound`，不让 GORM 错误漏到 biz。

### 3. 事务

```go
err := db.Transaction(func(tx *gorm.DB) error {
    if err := tx.Create(&a).Error; err != nil { return err } // 返回错误即回滚
    return tx.Create(&b).Error
})
```

### 4. AutoMigrate 的能与不能

启动时对每个 model 执行 `db.AutoMigrate(&AlertRule{}, ...)`：

| 能 | 不能 |
|----|------|
| 建表、加列、加索引 | **删列**（遗留列会一直留着） |
| 放宽列类型（少数情形） | 改窄类型、改列名（改名=加新列） |

实务规则：加字段随便加（想好零值语义）；改名/删除要么接受遗留列，
要么写一次性修复逻辑，并在 PR 里写明。

### 5. 方言切换

`internal/pkg/dbx` 按 `ONGRID_DB_DIALECT` 选 MySQL / SQLite 驱动。
写 SQL 片段时避开方言特有函数，让两边都能跑（单测默认跑 SQLite 内存库的模式
在部分 data 测试里使用）。

## 在本仓库

| 想看什么 | 打开 |
|----------|------|
| 连接与方言装配 | `internal/pkg/dbx`、`cmd/ongrid/main.go` |
| 典型 repo 实现 | `internal/manager/data/alert/`、`data/edge/` |
| casbin 的策略表 | gorm-adapter 自动建 `casbin_rule` 表 |
| DSN 约定 | `parseTime=true&loc=Local`（Makefile `DB_DSN`） |

注意：**知识库文档不走 GORM**——正文存 qdrant payload（见
[RAG & Qdrant](./rag-qdrant.md)）；MySQL 只放结构化业务数据。

## 实用指引

```bash
# 进本地库看表
docker exec -it ongrid-mysql mysql -uongrid -pongrid ongrid -e 'show tables;'

# 看 GORM 实际发的 SQL：临时开 debug
db.Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Info)})
```

坑位：

- `Find` 查不到**不报错**（空 slice）；`First` 查不到报 `ErrRecordNotFound`——别混；
- `Updates(struct)` 跳过零值字段（false/0/"" 不更新）！更新布尔/清空字段用
  `Updates(map[string]any{...})` 或 `Select("col").Updates(...)`；
- 多租户：所有查询带 `org_id` 过滤（红线），从 ctx 取而不是参数传；
- 大批量写用 `CreateInBatches`，避免单条循环插。

## 学习资料

- [GORM 官方文档（中文）](https://gorm.io/zh_CN/docs/)
- 重点章节：Declaring Models / CRUD / Transactions / Migration
