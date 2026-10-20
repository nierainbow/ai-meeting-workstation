"""sidecar：ai-meeting-workstation 的本地 Python 旁路服务集合。

目前只有 voiceprint（声纹，8792）。Node 侧通过 VOICEPRINT_PYTHON_PATH 指定

解释器拉起；Python 文件不进 tsc/eslint/vitest 管辖范围（tsconfig include 仅
src/**）。
"""
