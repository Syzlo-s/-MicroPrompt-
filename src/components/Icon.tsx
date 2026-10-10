import React from "react";

/** 单色 SVG 图标：用 mask 方式渲染，颜色跟随 currentColor（红色线：单色可着色） */
export default function Icon({
  src,
  size = 17,
  className,
  style,
}: {
  src: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={"icon" + (className ? ` ${className}` : "")}
      style={{
        width: size,
        height: size,
        // 注意：Vite 内联的 SVG data URI 含单引号，必须用双引号包裹 url()，
        // 否则未加引号的 url(data:...'...) 会被浏览器判为非法 CSS 而丢弃，
        // 导致 mask 失效、图标显示成实心方块。
        WebkitMaskImage: `url("${src}")`,
        maskImage: `url("${src}")`,
        ...style,
      }}
    />
  );
}
