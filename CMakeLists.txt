cmake_minimum_required(VERSION 3.16)
project(MicroPrompt VERSION 1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

# 让 Release 构建体积更小、性能更好
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Qt6 REQUIRED COMPONENTS Widgets Svg)

set(SOURCES
    main.cpp
    MainWindow.cpp
    NoteManager.cpp
    NoteListWidget.cpp
    NoteEditor.cpp
    PinButton.cpp
    TitleBarButton.cpp
    SvgIconLoader.cpp
    SplashScreen.cpp
    CrashHandler.cpp
    SoundUtil.cpp
    AutoHideScrollBar.cpp
)

set(HEADERS
    MainWindow.h
    NoteManager.h
    NoteListWidget.h
    NoteEditor.h
    PinButton.h
    TitleBarButton.h
    SvgIconLoader.h
    SplashScreen.h
    CrashHandler.h
    SoundUtil.h
    AutoHideScrollBar.h
)

set(RESOURCES resources.qrc)

# Windows 资源文件（exe 图标）
if(WIN32)
    set(RC_FILES app.rc)
endif()

add_executable(MicroPrompt WIN32 ${SOURCES} ${HEADERS} ${RESOURCES} ${RC_FILES})

target_link_libraries(MicroPrompt PRIVATE Qt6::Widgets Qt6::Svg)

# Windows DWM 圆角窗口 API
if(WIN32)
    target_link_libraries(MicroPrompt PRIVATE dwmapi)
    # MCI：播放"再见"音频（MP3）
    target_link_libraries(MicroPrompt PRIVATE winmm)
endif()

if(WIN32)
    target_compile_definitions(MicroPrompt PRIVATE UNICODE _UNICODE NOMINMAX)
    # 请求 Windows 10/11 以使用现代 API
    target_compile_definitions(MicroPrompt PRIVATE _WIN32_WINNT=0x0A00)
endif()

# Release 模式下优化体积
if(MSVC)
    target_compile_options(MicroPrompt PRIVATE /O2 /GL)
else()
    target_compile_options(MicroPrompt PRIVATE -O2 -s)
endif()
