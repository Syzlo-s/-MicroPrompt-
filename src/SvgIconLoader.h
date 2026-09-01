#ifndef SVGICONLOADER_H
#define SVGICONLOADER_H

#include <QIcon>
#include <QColor>
#include <QSize>
#include <QPixmap>
#include <QString>

/**
 * @brief SVG 图标加载工具
 *
 * 图标库中的 SVG 使用 <style>.cls-1{fill:#25314c;}</style> 定义颜色，
 * Qt 的 QSvgRenderer 对 CSS 类支持有限。此工具在加载时：
 *   1. 读取 SVG 文本
 *   2. 移除 <defs><style>...</style></defs>
 *   3. 将 path 的 fill 替换为指定颜色（内联属性）
 *   4. 渲染为 QIcon
 */
class SvgIconLoader {
public:
    /** 从资源路径加载纯色图标 */
    static QIcon load(const QString& resourcePath, const QColor& color,
                      int size = 24);

    /** 按 SVG 原始配色渲染（不替换 fill 颜色），用于彩色 Logo/图标 */
    static QIcon loadOriginal(const QString& resourcePath, int size = 24);

    /** 加载带 normal/hover/pressed 多状态的图标 */
    static QIcon loadStates(const QString& resourcePath,
                            const QColor& normal,
                            const QColor& hover,
                            const QColor& pressed,
                            int size = 24);

private:
    static QPixmap render(const QString& svgData, const QColor& color,
                          int size);
    static QString prepareSvg(const QString& raw, const QColor& color);
};

#endif // SVGICONLOADER_H
