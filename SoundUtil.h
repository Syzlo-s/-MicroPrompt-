#ifndef SOUNDUTIL_H
#define SOUNDUTIL_H

// MCI 播放提示音（MP3）时会把系统主音量重置为 60%，
// 这两个函数用于：播放前保存当前系统音量，播放后延迟恢复，
// 保证提示音跟随系统当前音量播放，且不改变系统音量。
void saveSystemVolume();
void restoreSystemVolumeLater();

#endif // SOUNDUTIL_H
