# Teams View Design Implementation

根据 Pencil 设计稿 Node ID: QpjCw 完整实现的 TeamsView 组件，包含以下核心元素：

## 📦 新增组件

### 1. ConnectionLines 连接线组件
- **ConnLeaderToCoder**: Leader 到 Coder 的连接线（紫色主题）
- **ConnLeaderToReviewer**: Leader 到 Reviewer 的连接线（紫色主题）
- **ConnCoderToReviewer**: Coder 到 Reviewer 的连接线（蓝色主题）

### 2. FlowingDots 流动点组件
包含8个流动点，每个都有主点和轨迹点：
- **L2C流**: 紫色主题，任务分配流
- **L2R流**: 紫色主题，任务分配流
- **C2R流**: 蓝色主题，代码审查流
- **C2L流**: 绿色主题，状态反馈流

### 3. DataTags 数据标签组件
- **Task Assign**: 任务分配标签（紫色主题）
- **Code Review**: 代码审查标签（蓝色主题）
- **Status**: 状态标签（绿色主题）

### 4. AnimationSpec 动画说明面板
- 显示实时动画状态
- 300ms 循环信息
- 任务流和协调指示器

### 5. FloatingBubble 浮动消息输入栏
- 现代化的消息输入界面
- 毛玻璃效果和渐变阴影
- 替代原有的 TaskInputBar

## 🎨 设计特色

### 视觉效果
- **连接线**: 使用 SVG 路径实现平滑曲线
- **流动点**: 300ms 循环动画，带有发光效果
- **数据标签**: 毛玻璃效果，主题色彩配置
- **卡片定位**: 固定位置布局，Leader(270,20), Coder(20,345), Reviewer(500,345)

### 动画系统
- **脉冲动画**: 300ms 交替缩放
- **轨迹动画**: 2s 循环移动路径
- **发光效果**: 动态阴影和颜色变化
- **平滑过渡**: CSS transition 优化

### 响应式设计
- 组件自适应容器大小
- 动画在不同屏幕尺寸下保持一致性
- 保留现有右侧 AgentDetailPanel 功能

## 🛠 技术实现

### 组件架构
```
TeamsView
├── ConnectionLines (SVG 连接线)
├── FlowingDots (流动点动画)
├── DataTags (数据标签)
├── AnimationSpec (动画说明)
├── FloatingBubble (消息输入)
└── AgentCard[] (Agent 卡片)
```

### 样式系统
- CSS-in-JS 实现
- 主题色彩统一管理
- 动画关键帧定义
- z-index 层次管理

### 性能优化
- 条件渲染：仅在团队活跃时显示设计元素
- 动画优化：使用 transform 和 opacity
- 内存管理：合理的组件卸载

## 📱 使用方式

组件会在以下条件下显示完整设计效果：
- 团队状态为 `ready` 或 `running`
- 至少有 3 个 Agent（Leader、Coder、Reviewer）

当团队不活跃时，只显示基础的 Agent 卡片布局，确保性能和用户体验。

## 🎯 设计细节严格遵循

- 严格按照设计稿中的颜色、尺寸、位置实现
- 保持 300ms 动画循环
- 维持原有功能的完整性
- 响应式设计适配不同屏幕