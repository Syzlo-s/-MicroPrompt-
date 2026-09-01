#include "SvgIconLoader.h"

#include <QFile>
#include <QImage>
#include <QPainter>
#include <QSvgRenderer>
#include <QRegularExpression>
#include <QGuiApplication>
#include <QScreen>
#include <QHash>

namespace {

// 图标缓存：每次 load 都会用 1024×1024 超采样渲染（峰值约 8~12MB 临时内存），
// 而同一 (资源路径, 颜色, 大小) 组合在运行期会被反复请求（右键菜单每次打开、
// 最大化/还原切换、列表头与右键菜单共用 shanchu.svg 等）。
// 命中缓存后直接复用 QIcon（隐式共享，拷贝零成本），完全跳过文件读取、
// SVG 预处理与超采样渲染。缓存 key 同时包含颜色与大小，保证不同主题色/
// 尺寸互不污染；颜色用 RGB name()（prepareSvg 只用到 RGB，输出与之精确对应）。
QHash<QString, QIcon>& iconCache()
{
    static QHash<QString, QIcon> cache;
    return cache;
}

} // namespace

QIcon SvgIconLoader::load(const QString& resourcePath, const QColor& color, int size)
{
    const QString key = QStringLiteral("load|") + resourcePath + QLatin1Char('|')
                        + color.name() + QLatin1Char('|') + QString::number(size);
    auto& cache = iconCache();
    const auto it = cache.constFind(key);
    if (it != cache.constEnd())
        return it.value();

    QFile f(resourcePath);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return QIcon();

    const QString raw = QString::fromUtf8(f.readAll());
    f.close();

    QPixmap pix = render(prepareSvg(raw, color), color, size);
    QIcon icon(pix);
    if (!icon.isNull())
        cache.insert(key, icon);
    return icon;
}

QIcon SvgIconLoader::loadOriginal(const QString& resourcePath, int size)
{
    const QString key = QStringLiteral("orig|") + resourcePath + QLatin1Char('|')
                        + QString::number(size);
    auto& cache = iconCache();
    const auto it = cache.constFind(key);
    if (it != cache.constEnd())
        return it.value();

    QFile f(resourcePath);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return QIcon();

    const QString raw = QString::fromUtf8(f.readAll());
    f.close();

    // 使用 SVG 自身配色直接渲染（render 不依赖 color 参数）
    QPixmap pix = render(raw, QColor(), size);
    QIcon icon(pix);
    if (!icon.isNull())
        cache.insert(key, icon);
    return icon;
}

QIcon SvgIconLoader::loadStates(const QString& resourcePath,
                                const QColor& normal,
                                const QColor& hover,
                                const QColor& pressed,
                                int size)
{
    const QString key = QStringLiteral("states|") + resourcePath + QLatin1Char('|')
                        + normal.name() + QLatin1Char('|')
                        + hover.name() + QLatin1Char('|')
                        + pressed.name() + QLatin1Char('|')
                        + QString::number(size);
    auto& cache = iconCache();
    const auto it = cache.constFind(key);
    if (it != cache.constEnd())
        return it.value();

    QFile f(resourcePath);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text))
        return QIcon();

    const QString raw = QString::fromUtf8(f.readAll());
    f.close();

    QIcon icon;
    icon.addPixmap(render(prepareSvg(raw, normal), normal, size), QIcon::Normal);
    icon.addPixmap(render(prepareSvg(raw, hover), hover, size), QIcon::Active);
    icon.addPixmap(render(prepareSvg(raw, pressed), pressed, size), QIcon::Selected);
    icon.addPixmap(render(prepareSvg(raw, normal), normal, size), QIcon::Disabled);
    if (!icon.isNull())
        cache.insert(key, icon);
    return icon;
}

QString SvgIconLoader::prepareSvg(const QString& raw, const QColor& color)
{
    QString svg = raw;

    // 1. 移除 <defs><style>...</style></defs>
    static const QRegularExpression styleRe(
        QStringLiteral("<defs>\\s*<style>[^<]*</style>\\s*</defs>"));
    svg.remove(styleRe);

    // 2. 移除单独的 <style>...</style>
    static const QRegularExpression styleRe2(
        QStringLiteral("<style>[^<]*</style>"));
    svg.remove(styleRe2);

    // 3. 将 fill 替换为指定颜色（内联属性，Qt 可正确解析）
    static const QRegularExpression fillRe(QStringLiteral("fill:#[0-9a-fA-F]{6}"));
    svg.replace(fillRe, QStringLiteral("fill:%1").arg(color.name()));

    // 4. 兜底：如果 path 上没有 fill，追加内联 fill（正确处理自闭合标签）
    static const QRegularExpression pathRe(
        QStringLiteral("<path[^>]*?/?>|</path>"));
    QRegularExpressionMatchIterator it = pathRe.globalMatch(svg);
    QString result;
    qsizetype lastPos = 0;
    while (it.hasNext()) {
        const QRegularExpressionMatch m = it.next();
        result += svg.mid(lastPos, m.capturedStart() - lastPos);
        const QString whole = m.captured(0);
        if (whole.startsWith(QStringLiteral("</path>"))
            || whole.contains(QStringLiteral("fill="))) {
            result += whole;
        } else if (whole.endsWith(QLatin1String("/>"))) {
            // 自闭合：在 /> 前插入 fill
            result += whole.left(whole.size() - 2)
                      + QStringLiteral(" fill=\"%1\"/>").arg(color.name());
        } else {
            // 普通闭合：在 > 前插入 fill
            result += whole.left(whole.size() - 1)
                      + QStringLiteral(" fill=\"%1\">").arg(color.name());
        }
        lastPos = m.capturedEnd();
    }
    result += svg.mid(lastPos);

    // 5. 统一重着色：icons 自绘新图标以 #25314C 作为字形与方框的基准色
    //    （fill 与 stroke 均为该色），直接替换为调用方传入的主题色。
    //    全项目仅这 7 个图标使用该颜色，不会影响其他图标。
    result.replace(QStringLiteral("#25314C"), color.name());
    return result;
}

QPixmap SvgIconLoader::render(const QString& svgData, const QColor& color,
                              int size)
{
    Q_UNUSED(color)

    QSvgRenderer renderer;
    if (!renderer.load(svgData.toUtf8()))
        return QPixmap();

    // 先以高分辨率渲染，保留矢量细节，避免小尺寸下锯齿/发虚
    // 1024px 超采样：缩小到 24~48px 时边缘依然锐利、细线条清晰
    constexpr int hi = 1024;
    QPixmap big(hi, hi);
    big.fill(Qt::transparent);
    {
        QPainter p(&big);
        p.setRenderHint(QPainter::Antialiasing);
        renderer.render(&p);
    }

    // 扫描非透明像素，得到图标实际内容的包围盒（剔除 viewBox 中的留白）。
    // 扫描只读取 alpha 字节：ARGB32 与 ARGB32_Premultiplied 的 alpha 完全一致
    //（预乘只作用于 RGB），因此无需再转一份 ARGB32 副本，每次渲染少一次 ~4MB 分配。
    QImage img = big.toImage();
    if (img.format() != QImage::Format_ARGB32
        && img.format() != QImage::Format_ARGB32_Premultiplied) {
        img = img.convertToFormat(QImage::Format_ARGB32);
    }
    int minX = hi, minY = hi, maxX = -1, maxY = -1;
    for (int y = 0; y < hi; ++y) {
        const QRgb* line = reinterpret_cast<const QRgb*>(img.constScanLine(y));
        for (int x = 0; x < hi; ++x) {
            if (qAlpha(line[x]) > 8) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0)
        return QPixmap(); // 空图标

    const QRect content(minX, minY, maxX - minX + 1, maxY - minY + 1);

    // 输出位图按设备像素比放大，保证高分屏（125%/150%/200%）依然清晰。
    // primaryScreen 在极早期可能为空，用应用级 DPR 兜底（Qt 6.3+）。
    qreal dpr = 1.0;
    if (const QScreen* s = QGuiApplication::primaryScreen())
        dpr = s->devicePixelRatio();
    if (dpr <= 1.0)
        dpr = qMax<qreal>(1.0, qGuiApp->devicePixelRatio());
    const int out = int(qRound(size * qMax<qreal>(1.0, dpr)));
    QPixmap pix(out, out);
    pix.setDevicePixelRatio(qMax<qreal>(1.0, dpr));
    pix.fill(Qt::transparent);

    // 内容等比缩放并居中（四周保留约 6% 视觉边距），使任意图标的视觉大小统一
    const int pad = qMax(2, size / 16);
    const int inner = size - pad * 2;
    QSize drawSize = content.size();
    drawSize.scale(inner, inner, Qt::KeepAspectRatio);

    QPainter p(&pix);
    p.setRenderHint(QPainter::Antialiasing);
    p.setRenderHint(QPainter::SmoothPixmapTransform);
    p.drawPixmap(QRect((size - drawSize.width()) / 2,
                       (size - drawSize.height()) / 2,
                       drawSize.width(), drawSize.height()),
                 big, content);
    p.end();

    return pix;
}
