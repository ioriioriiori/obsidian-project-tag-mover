"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const {
  Plugin,
  Notice,
  parseYaml,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath // Add this
} = require("obsidian");

/* ---------- デフォルト設定 ---------- */
const DEFAULT_SETTINGS = {
  tagPrefix: "#pjt/",
  rootFolder: "03_project",
  notesFolder: "02/notes",
  tagRules: [
    {
      tagPattern: "work/urgent",
      destination: "01_inbox/urgent"
    },
    {
      tagPattern: "personal/health",
      destination: "04_personal/health"
    }
  ]
};

/* ---------- プラグイン本体 ---------- */
class ProjectTagMover extends Plugin {
  async onload() {
    console.log("ProjectTagMover loading…");
    await this.loadSettings();
    this.addSettingTab(new ProjectTagMoverSettingTab(this.app, this));

    /* コマンド登録 */
    this.addCommand({
      id: "move-note-by-tag",
      name: "現在開いているmdをタグで指定ファイルに振り分け",
      callback: async () => await this.moveActiveFile()
    });

    this.addCommand({
      id: "move-all-notes-by-tag",
      name: "フォルダ内のmdファイルをタグで指定ファイルへ一括移動",
      callback: async () => await this.moveAllFiles()
    });
  }

  async moveActiveFile() {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || !file.path.endsWith(".md")) {
      new Notice("アクティブな Markdown ファイルがありません。");
      return;
    }

    let content;
    try {
      content = await this.app.vault.read(file);
    } catch (e) {
      console.error("ファイル読み込み失敗:", e);
      new Notice("ファイル読込に失敗しました。");
      return;
    }

    const tags = [];

    // 1) YAML frontmatter の tags 抽出
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      try {
        const fmObj = parseYaml(fmMatch[1]);
        if (fmObj && fmObj.tags) {
          const fmTags = Array.isArray(fmObj.tags) ? fmObj.tags : [fmObj.tags];
          tags.push(...fmTags.map(t => String(t)));
        }
      } catch (e) {
        console.warn("YAML 解析に失敗:", e);
      }
    }

    // 2) 本文から #pjt/xxx を抽出 (frontmatter 部は除外)
    const body = fmMatch ? content.slice(fmMatch[0].length) : content;
    // プレフィックス先頭の # はあってもなくても OK に
    const rawPrefix = this.settings.tagPrefix.replace(/^#/, "");
    const prefixEsc = rawPrefix.replace("/", "\\/");
    const regex = new RegExp(`[#]?${prefixEsc}[^\\s#]+`, "g");
    const bodyMatches = body.match(regex);
    if (bodyMatches) {
      tags.push(...bodyMatches);
    }

    console.log("検出したタグリスト:", tags);

    // 3) 最初にマッチした #?pjt/... を採用
    const first = tags
      .map(t => String(t).replace(/^["'#]+|["']+$/g, "").replace(/^#/, ""))
      .find(t => t.startsWith(rawPrefix));

    if (!first) {
      new Notice("対応する pjt/ タグが見つかりません。");
      return;
    }

    const relativePath = first.substring(rawPrefix.length);
    await this.moveFileToProject(file, relativePath, false);
  }

  async moveAllFiles() {
    const files = this.app.vault.getMarkdownFiles();
    const targetFiles = files.filter(file => 
      file.path.startsWith(this.settings.notesFolder) && 
      file.path.endsWith(".md")
    );

    if (targetFiles.length === 0) {
      new Notice("処理対象のファイルが見つかりません。");
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const file of targetFiles) {
      try {
        await this.processFile(file);
        successCount++;
      } catch (e) {
        console.error(`ファイル処理失敗: ${file.path}`, e);
        failCount++;
      }
    }

    new Notice(`処理完了: ${successCount}件成功, ${failCount}件失敗`);
  }

  async processFile(file) {
    let content;
    try {
      content = await this.app.vault.read(file);
    } catch (e) {
      console.error("ファイル読み込み失敗:", e);
      throw new Error("ファイル読込に失敗しました。");
    }

    const tags = [];

    // 1) YAML frontmatter の tags 抽出
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      try {
        const fmObj = parseYaml(fmMatch[1]);
        if (fmObj && fmObj.tags) {
          const fmTags = Array.isArray(fmObj.tags) ? fmObj.tags : [fmObj.tags];
          // #の有無を統一（#を除去）
          tags.push(...fmTags.map(t => String(t).replace(/^#/, "")));
        }
      } catch (e) {
        console.warn("YAML 解析に失敗:", e);
      }
    }

    // 2) 本文からタグを抽出（#の有無に関わらず）
    const body = fmMatch ? content.slice(fmMatch[0].length) : content;
    // #で始まるタグと、#なしのタグの両方を検出
    const regex = /(?:^|\s)(?:#)?([\w/-]+)(?=\s|$)/g;
    let match;
    while ((match = regex.exec(body)) !== null) {
      tags.push(match[1]);
    }

    console.log(`[ProjectTagMover] ファイル ${file.path} から検出したタグ:`, tags);

    if (tags.length === 0) {
      throw new Error("タグが見つかりません。");
    }

    // 3) タグルールに基づいて移動先を決定
    for (const pattern of tags) {
      // Normalize the scanned 'pattern' from the note by removing any leading '#'
      const normalizedPattern = pattern.replace(/^#/, "");

      const rule = this.settings.tagRules.find(r =>
        // Normalize r.tagPattern from settings by removing any leading '#'
        r.tagPattern.replace(/^#/, "") === normalizedPattern
      );
      if (rule) {
        console.log(`[ProjectTagMover] ルールにマッチ: ${pattern} (normalized to ${normalizedPattern}) → ${rule.destination}`);
        const moveSuccess = await this.moveFileToProject(file, rule.destination, true);
        if (!moveSuccess) {
          throw new Error(`Failed to move file based on rule: ${pattern} → ${rule.destination}`);
        }
        return; // Success, exit
      }
    }

    // 4) デフォルトの処理（pjt/タグの場合）
    const pjtPrefix = this.settings.tagPrefix.replace(/^#/, "");
    const pjtTag = tags.find(t => t.startsWith(pjtPrefix));
    if (pjtTag) {
      const relativePath = pjtTag.substring(pjtPrefix.length);
      console.log(`[ProjectTagMover] デフォルト処理: ${pjtTag} → ${relativePath}`);
      const moveSuccess = await this.moveFileToProject(file, relativePath, false);
      if (!moveSuccess) {
        throw new Error(`Failed to move file based on pjt tag: ${pjtTag}`);
      }
      return; // Success, exit
    }

    throw new Error("対応するタグが見つかりません。"); // No rule or pjt tag matched
  }

  async moveFileToProject(file, path, isFullPath) {
    // Sanitize the input path to prevent traversal
    const sanitizedPathSegment = normalizePath(path);

    // Prevent empty or purely traversal paths after sanitization
    if (!sanitizedPathSegment || sanitizedPathSegment === '.' || sanitizedPathSegment.startsWith('..')) {
      new Notice(`Invalid path specified: ${path}`);
      console.error(`[ProjectTagMover] Invalid or traversal path detected and blocked: ${path}`);
      return false; // Indicate failure
    }

    const baseFolder = isFullPath
      ? '' // For full paths, the sanitizedPathSegment is from vault root
      : this.settings.rootFolder;

    // Construct targetPath using the sanitized segment
    // If isFullPath, sanitizedPathSegment is the full path from vault root (minus filename)
    // If not isFullPath, it's relative to baseFolder
    let preliminaryTargetPath;
    if (isFullPath) {
      // rule.destination should be a folder path, so we append the file name.
      preliminaryTargetPath = `${sanitizedPathSegment}/${file.name}`;
    } else {
      preliminaryTargetPath = `${baseFolder}/${sanitizedPathSegment}/${file.name}`;
    }

    // Normalize the ENTIRE path to resolve any '..' etc. introduced by baseFolder or filename
    const targetPath = normalizePath(preliminaryTargetPath);

    // Additional check: Ensure the target path is not attempting to escape the vault root
    // (normalizePath should handle this by keeping it relative, but an explicit check is good defense in depth)
    // This check might be redundant if normalizePath always guarantees paths are relative to vault root and don't start with '..'
    if (targetPath.startsWith('../')) {
      new Notice(`Blocked potentially malicious path: ${targetPath}`);
      console.error(`[ProjectTagMover] Blocked path escaping vault root: ${targetPath}`);
      return false; // Indicate failure
    }

    const folderPath = targetPath.substring(0, targetPath.lastIndexOf("/"));

    console.log(`[ProjectTagMover] 移動先: ${targetPath}`);
    console.log(`[ProjectTagMover] フォルダ作成: ${folderPath}`);

    try {
      // Check if folderPath is root before creating
      if (folderPath && !(await this.app.vault.adapter.exists(folderPath))) {
        await this.app.vault.adapter.mkdir(folderPath);
      } else if (!folderPath) {
        // This case means the file is being moved to the vault root.
        // Depending on desired behavior, this might be okay or might warrant a warning/block.
        // For now, allow it, assuming normalizePath has made it safe.
        console.log(`[ProjectTagMover] Target folder is vault root for path: ${targetPath}`);
      }
      await this.app.fileManager.renameFile(file, targetPath);
      new Notice(`Moved to '${targetPath}'`);
      console.log(`[ProjectTagMover] 移動完了: '${file.path}' → '${targetPath}'`);
      return true; // Indicate success
    } catch (e) {
      console.error("[ProjectTagMover] 移動失敗:", e);
      new Notice("ファイル移動に失敗しました。");
      return false; // Indicate failure
    }
  }

  onunload() {
    console.log("ProjectTagMover unloaded.");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
exports.default = ProjectTagMover;

/* ---------- 設定画面 ---------- */
class ProjectTagMoverSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Project Tag Mover Settings" });

    new Setting(containerEl)
      .setName("タグプレフィックス")
      .setDesc("プロジェクトタグの接頭辞（例: #pjt/ または pjt/）")
      .addText(text =>
        text
          .setPlaceholder("#pjt/")
          .setValue(this.plugin.settings.tagPrefix)
          .onChange(async value => {
            try {
              this.plugin.settings.tagPrefix = value.trim();
              await this.plugin.saveSettings();
            } catch (e) {
              console.error("Failed to save Project Tag Mover settings (tagPrefix):", e);
              new Notice("Failed to save settings. Please check the console for details.");
            }
          })
      );

    new Setting(containerEl)
      .setName("ルートフォルダ")
      .setDesc("プロジェクトファイルの親ディレクトリ")
      .addText(text =>
        text
          .setPlaceholder("03_project")
          .setValue(this.plugin.settings.rootFolder)
          .onChange(async value => {
            try {
              this.plugin.settings.rootFolder = value.trim();
              await this.plugin.saveSettings();
            } catch (e) {
              console.error("Failed to save Project Tag Mover settings (rootFolder):", e);
              new Notice("Failed to save settings. Please check the console for details.");
            }
          })
      );

    new Setting(containerEl)
      .setName("ノートフォルダ")
      .setDesc("一括処理対象のフォルダ")
      .addText(text =>
        text
          .setPlaceholder("02/notes")
          .setValue(this.plugin.settings.notesFolder)
          .onChange(async value => {
            try {
              this.plugin.settings.notesFolder = value.trim();
              await this.plugin.saveSettings();
            } catch (e) {
              console.error("Failed to save Project Tag Mover settings (notesFolder):", e);
              new Notice("Failed to save settings. Please check the console for details.");
            }
          })
      );

    // 特別な移動ルールセクション
    containerEl.createEl("h3", { text: "特別な移動ルール" });
    containerEl.createEl("p", { 
      text: "特定のタグに対して、独自の移動先を設定できます。",
      cls: "setting-item-description"
    });
    const rulesContainer = containerEl.createDiv("tag-rules-container");

    // 既存のルールを表示
    this.plugin.settings.tagRules.forEach((rule, index) => {
      this.createRuleSetting(rulesContainer, rule, index);
    });

    // 新しいルールを追加するボタン
    new Setting(rulesContainer)
      .setName("新しいルールを追加")
      .addButton(button => {
        button
          .setButtonText("追加")
          .onClick(async () => {
            this.plugin.settings.tagRules.push({
              tagPattern: "",
              destination: ""
            });
            await this.plugin.saveSettings(); // This one re-renders, so error handling might be different or less critical if display() fails after it.
            // For now, let's assume saveSettings is the primary point of failure.
            // If saveSettings fails, display() won't be called with potentially unsaved data.
          } catch (e) {
            console.error("Failed to save Project Tag Mover settings (add new rule):", e);
            new Notice("Failed to save settings when adding a new rule. Please check the console.");
          } finally {
            // Ensure display is called to refresh the UI even if save fails,
            // though the new (unsaved) rule might disappear or an old state might be shown.
            // Alternatively, only call display on success. For now, always call.
            this.display();
          }
          });
      });
  }

  createRuleSetting(container, rule, index) {
    const ruleContainer = container.createDiv("tag-rule-setting");
    
    new Setting(ruleContainer)
      .setName(`ルール ${index + 1}`)
      .addText(text => {
        text
          // Old: .setPlaceholder("タグ名（例: work/urgent または #work/urgent）")
          .setPlaceholder("タグ名 (例: work/urgent)") // New placeholder
          .setValue(rule.tagPattern)
          .onChange(async value => {
            try {
              // Optional: you could also normalize here before saving, e.g.
              // this.plugin.settings.tagRules[index].tagPattern = value.trim().replace(/^#/, "");
              // However, with the matching logic change, it's not strictly necessary for functionality.
              // For consistency, let's trim and remove leading # when saving.
              this.plugin.settings.tagRules[index].tagPattern = value.trim().replace(/^#/, "");
              await this.plugin.saveSettings();
            } catch (e) {
              console.error("Failed to save Project Tag Mover settings (tagPattern for a rule):", e);
              new Notice("Failed to save settings for a rule. Please check the console.");
            }
          });
      })
      .addText(text => {
        text
          .setPlaceholder("移動先フォルダ（例: 01_inbox/urgent）")
          .setValue(rule.destination)
          .onChange(async value => {
            try {
              this.plugin.settings.tagRules[index].destination = value.trim();
              await this.plugin.saveSettings();
            } catch (e) {
              console.error("Failed to save Project Tag Mover settings (destination for a rule):", e);
              new Notice("Failed to save settings for a rule. Please check the console.");
            }
          });
      })
      .addButton(button => {
        button
          .setButtonText("削除")
          .onClick(async () => {
            try {
              this.plugin.settings.tagRules.splice(index, 1);
              await this.plugin.saveSettings();
            } catch (e) {
              console.error("Failed to save Project Tag Mover settings (delete rule):", e);
              new Notice("Failed to save settings when deleting a rule. Please check the console.");
            } finally {
              // Ensure display is called to refresh the UI
              this.display();
            }
          });
      });
  }
}
