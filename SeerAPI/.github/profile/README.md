<div align="center">

# SeerAPI

**赛尔号游戏数据开放平台**

[![GitHub](https://img.shields.io/badge/GitHub-SeerAPI-blue?logo=github)](https://github.com/SeerAPI)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.10+-blue.svg)](https://python.org)

为赛尔号游戏开发者提供标准化、结构化的游戏数据 API 服务</br>
~~完整文档还没写好，凑合看吧~~

</div>

---

## 📖 项目特性

- 🎯 **标准化游戏数据**：分析赛尔号三平台（Flash、HTML5、Unity）的客户端数据，整理为统一的标准格式
- 🌐 **开放数据访问**：通过 RESTful API 为开发者提供便捷的数据访问接口，并提供官方客户端库
- 🛠️ **工具链生态**：构建完整的数据处理工具链，从资源提取到 API 服务
- 🤝 **社区驱动**：这是一项庞大且需要持续维护的项目，欢迎社区贡献解析器、数据补丁和工具改进


## 🚀 快速开始

### 使用 Python SDK

安装客户端库：

```bash
pip install seerapi
```

使用示例：

```python
import asyncio
from seerapi import SeerAPI, PageInfo

async def main():
    async with SeerAPI() as client:
        # 获取单个精灵信息
        pet = await client.get('pet', id=1)
        print(f"精灵名称: {pet.name}")
        
        # 获取所有前十个精灵信息
        async for pet in client.paged_list('pet', PageInfo(offset=0, limit=10)):
            print(f"ID: {pet.id}, 名称: {pet.name}")

asyncio.run(main())
```

## 🎯 数据类型

SeerAPI 提供 **50+ 种游戏资源类型**，包括但不限于：

- 🐾 **精灵**：精灵基础信息、属性、种族值、可学习的技能等
- ⚔️ **技能**：技能效果、威力、PP 值，效果描述/ID/参数等
- 🎒 **道具**：物品分类、描述
- 🛡️ **装备**：装备属性、套装效果
- 💎 **刻印**：刻印效果、宝石等
- 🌟 **特性**：精灵特性、特质等
- 📜 更多资源请查看[API 参考](https://api.seerapi.com/docs/v1/api_reference.html)，文档补充中...

每个资源类型都有对应的Schema定义，访问[https://api.seerapi.com/v1/schemas/{resource_name}/$id](https://api.seerapi.com/v1/schemas/{resource_name}/$id)查看。

## 🤝 贡献

我们欢迎所有形式的贡献！

### 如何贡献

1. **添加解析器**：Solaris 需要更多的数据解析器
   - Fork [Solaris](https://github.com/SeerAPI/seerapi) 仓库
   - 在 `package/solaris/parse/parsers/` 下添加新解析器
   - 提交 Pull Request

2. **修复数据错误**：发现源数据错误？
   - 在 [patch-sources](https://github.com/SeerAPI/patch-sources) 提交补丁

3. **改进文档**：帮助我们完善文档和示例

4. **报告问题**：在相应仓库提交 Issue

## 📜 许可证

SeerAPI 的大部分项目采用 **MIT License** 开源。

具体许可信息请查看各仓库的 LICENSE 文件。

## ❤️ 特别鸣谢

- [@HurryWang](https://github.com/WhY15w) 和他的 [赛尔号信息聚合页](https://seerinfo.yuyuqaq.cn/)
- [@火火](https://github.com/Yogurt114514) 在数据分析过程中提供的帮助
- 所有的赛尔号开源开发者们
