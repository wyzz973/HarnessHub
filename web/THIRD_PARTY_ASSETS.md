# 品牌图标来源

Harness 与已识别官方 Provider 的品牌图标使用固定依赖 `@lobehub/icons-static-svg@1.95.1`，从包内 SVG 本地构建；运行时不连接图标 CDN、不下载远程图片。仅引入实际使用的图标文件。

来源：[Lobe Icons 官方仓库](https://github.com/lobehub/lobe-icons)，[MIT 许可证](https://github.com/lobehub/lobe-icons/blob/master/LICENSE)。品牌名称与商标归各自权利人所有，图标用于辨认产品，不表示合作或背书。无已审阅图标的产品使用明确的名称首字标识，不仿造品牌图案。

Pi 使用的是块状 P 编程 Agent 图标，已和 [Magpie 的 Pi CLI 本地图标](https://github.com/yetone/magpie/blob/331b692d184df4f651ae15ae2ec4d3690196b50d/internal/gui/assets/icons/pi.svg)逐字节核对一致，不使用 Inflection 标识。Qwen 同时映射 `qwen` 与 `qwen-code` 的已知目录身份。

Factory Droid 使用 [Magpie 固定版本中的 Factory SVG](https://github.com/yetone/magpie/blob/331b692d184df4f651ae15ae2ec4d3690196b50d/internal/gui/assets/icons/factory.svg)，保存在 `src/assets/factory.svg`，SHA-256 为 `6a502c844029a326e77aff6554210629ee3e735d81ae42d2b98be0eb20c48bf3`；取得时核对仅含 SVG、title、path、g，无事件处理、外部 href 或 URL。源仓库 [MIT 许可证](https://github.com/yetone/magpie/blob/331b692d184df4f651ae15ae2ec4d3690196b50d/LICENSE)归 yetone 所有；同样只用作产品辨认。

以下四个 SVG 取自 ACP 官方 registry 的固定 `c56a2b3f94c98b14f8145eb93d87359470c930d8`，复制前和调研者记录的源 SHA-256 逐项核对。已审阅 XML，无脚本、事件、foreignObject、动画、外部 URI 或 CSS import；本地使用仅标识对应产品。Registry 的 Apache-2.0 与 Agent 所声明的许可证不等于独立商标/素材授权，本项目不把这些图标统一宣称为 MIT。

| 本地文件 | 固定来源 | SHA-256 | 上游许可证观察 |
|---|---|---|---|
| `src/assets/auggie.svg` | [ACP Auggie](https://github.com/agentclientprotocol/registry/blob/c56a2b3f94c98b14f8145eb93d87359470c930d8/auggie/icon.svg) | `66f6c787deecab872b78e68a413227db20a2be770732682bbd73e14fd2602345` | [专有许可](https://github.com/augmentcode/auggie/blob/main/LICENSE.md)，Copyright (c) 2025, Augment Computing, Inc. |
| `src/assets/dirac.svg` | [ACP Dirac](https://github.com/agentclientprotocol/registry/blob/c56a2b3f94c98b14f8145eb93d87359470c930d8/dirac/icon.svg) | `cb901f52cad80851dc7ea745b0793b051dabd442f8256a475325388a0dda9381` | [Apache-2.0](https://github.com/dirac-run/dirac/blob/master/LICENSE) |
| `src/assets/nova.svg` | [ACP Nova](https://github.com/agentclientprotocol/registry/blob/c56a2b3f94c98b14f8145eb93d87359470c930d8/nova/icon.svg) | `6fae2c9dd17034305ae0c07410564f3ad15f7c38ce383084fa60df1295e149aa` | Registry 标为 proprietary；[当前官方许可](https://github.com/Compass-Agentic-Platform/nova/blob/main/LICENSE)为 MIT，Copyright (c) 2026 Compass Agentic Platform。记录差异，不据此改写登记许可 |
| `src/assets/stakpak.svg` | [ACP Stakpak](https://github.com/agentclientprotocol/registry/blob/c56a2b3f94c98b14f8145eb93d87359470c930d8/stakpak/icon.svg) | `37668a944f30f03a3af74d98e7fe1b68dcbacdebad9f5b46c4e241a12be244c1` | [Apache-2.0](https://github.com/stakpak/agent/blob/main/LICENSE) |

MIT License

Copyright (c) 2023 LobeHub

Copyright (c) 2026 yetone (Factory SVG)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


## ACP Registry 许可证副本

以下保留固定 Registry 的许可证正文，供随素材分发核对；不扩大上表厂商许可或商标范围。

~~~text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to the Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
~~~

## 本机接入图标补齐（2026-10-11）

Claude Agent/Claude Code目录身份补映射到固定Lobe Icons的Claude Code图标，Pi ACP映射到Pi；其余新增图标来自同一已固定ACP Registry提交。SVG逐项检查元素和属性，拒绝脚本、事件、foreignObject及外部链接，不使用运行时CDN。上游品牌/素材权利不由Registry许可推断。

| 图标 | 固定来源 | SHA256 |
|---|---|---|
| agoragentic-acp | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/agoragentic-acp/icon.svg) | a185cdd875bc41d6b288a639e019391b65f50df75e4d5a8ca07640786704d98b |
| autohand | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/autohand/icon.svg) | 6324e552f6c85025642ca9aabf4adddb4bba318a6f9422c7053fd4c610914120 |
| cortex-code | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/cortex-code/icon.svg) | 70128bcb28473e73b53f93f9fea286004633acca8d378b9d97846463bdbefee1 |
| corust-agent | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/corust-agent/icon.svg) | 41a66ffc695728671a7bed4ebdf0c1c27e4c22f75e1e06f98e39459190e13157 |
| crow-cli | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/crow-cli/icon.svg) | e5bf3c1707a3804f57e4ee12dbefd6ac91d03ec461d951b4ae22cc766bb0a411 |
| deepagents | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/deepagents/icon.svg) | bb0fed2e9587992e5814c64df443109dd82520559f3527b1a3270477083712e6 |
| dimcode | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/dimcode/icon.svg) | 0c8a5019f004e420871e9550e55420edaa5ecbf3e5559176338ef0053f966082 |
| fast-agent | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/fast-agent/icon.svg) | f70197d4bfb23053ad3d25db4f1651211776043deaca1f94565e4683ee40216a |
| harn | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/harn/icon.svg) | c87bdd7da801e86406f62518071cffc00c37fea99bde41c0dc68b8eba7257356 |
| kimchi | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/kimchi/icon.svg) | d246ec242fb714ae57c66ce7cfd4d24a05ec092c50b7320c340cc10bf79c7aa4 |
| minion-code | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/minion-code/icon.svg) | a786bb89317134be8211f10826585e14c041016708cbe8d89b18fd7a0f64057c |
| sigit | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/sigit/icon.svg) | db67e17540399da6db400cf07c6d0d23161f67a1bf11186ae7fa72c5de8943ee |
| vtcode | [官方Registry](https://raw.githubusercontent.com/agentclientprotocol/registry/c56a2b3f94c98b14f8145eb93d87359470c930d8/vtcode/icon.svg) | 6f116d7447056cfe38e3512e4957a1360e3be21a72da9589ac702e073513ff5d |
