# 賽爾號 單機版（非官方粉絲作品）

純前端、可直接部署到 GitHub Pages 的單機精靈冒險遊戲，資料與精靈圖來自本 repo 匯入的 SeerAPI。

## 內容
- 6 顆星球 + 太空站，草叢遇怪、6 位星球守護者與徽章
- 300 隻精靈（屬性、種族值、性格、個體值、學習技能、進化鏈）
- 26 系屬性相剋、物攻/特攻/屬性技能、能力等級、麻痺/中毒/燒傷/凍傷/害怕/疲憊、吸血、反彈、連擊等技能效果
- 捕捉、經驗升級、學新技能、進化、補給站、倉庫、圖鑑、localStorage 存檔
- 鍵盤（方向鍵/WASD + 空白/Enter）與手機觸控

## 本機執行
```bash
python3 -m http.server -d game/site 8000
```

## 重新打包資料
```bash
python3 game/tools/build_data.py 300
```
參數是收錄的最大精靈編號，越大檔案越多（需要 Pillow）。

## 部署
推到 `main` 後 `.github/workflows/pages.yml` 會只 sparse-checkout `game/site` 並部署。
第一次需到 repo 的 Settings → Pages → Source 選 **GitHub Actions**。

所有精靈圖像與遊戲資料版權歸上海淘米網絡科技有限公司所有，僅供學習交流。
