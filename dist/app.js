const fileInput = document.querySelector('#fileInput');
const dropZone = document.querySelector('#dropZone');
const fileList = document.querySelector('#fileList');
const toast = document.querySelector('#toast');
const chatForm = document.querySelector('#chatForm');
const chatInput = document.querySelector('#chatInput');
const chat = document.querySelector('#chat');

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('is-visible'), 2200);
}

function readableSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function addFiles(files) {
  [...files].forEach((file) => {
    const item = document.createElement('button');
    item.className = 'file-item';
    item.type = 'button';
    const isImage = file.type.startsWith('image/');
    const ext = (file.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4);
    const visual = document.createElement('span');
    visual.className = isImage ? 'file-thumb' : 'file-type cad';
    if (isImage) {
      visual.style.backgroundImage = `url(${URL.createObjectURL(file)})`;
      visual.style.backgroundSize = 'cover';
      visual.style.backgroundPosition = 'center';
    } else {
      visual.textContent = ext;
    }
    const copy = document.createElement('span');
    copy.className = 'file-copy';
    const name = document.createElement('strong');
    name.textContent = file.name;
    const meta = document.createElement('small');
    meta.textContent = `${readableSize(file.size)} · 本次会话`;
    copy.append(name, meta);
    item.append(visual, copy);
    item.addEventListener('click', () => {
      document.querySelectorAll('.file-item').forEach((node) => node.classList.remove('is-selected'));
      item.classList.add('is-selected');
      document.querySelector('#contextChip').innerHTML = `<span>⌁</span> 已引用：${file.name} <button type="button" aria-label="移除引用">×</button>`;
      showToast(`已引用 ${file.name}`);
    });
    fileList.prepend(item);
  });
  if (files.length) showToast(`已添加 ${files.length} 个文件`);
}

fileInput.addEventListener('change', (event) => addFiles(event.target.files));
['dragenter', 'dragover'].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.add('is-dragging');
}));
['dragleave', 'drop'].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.remove('is-dragging');
}));
dropZone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = chatInput.value.trim();
  if (!value) return;
  const message = document.createElement('div');
  message.className = 'message user';
  message.innerHTML = `<span class="message-avatar">我</span><div><p></p></div>`;
  message.querySelector('p').textContent = value;
  chat.append(message);
  chatInput.value = '';
  chat.scrollTop = chat.scrollHeight;
  window.setTimeout(() => {
    const reply = document.createElement('div');
    reply.className = 'message assistant';
    reply.innerHTML = '<span class="message-avatar">AI</span><div><p>已记录。原型阶段会把这项要求整理到当前成果中，正式版本将结合引用资料生成内容。</p></div>';
    chat.append(reply);
    chat.scrollTop = chat.scrollHeight;
  }, 450);
});

document.querySelector('#attachButton').addEventListener('click', () => fileInput.click());
document.querySelector('#generateButton').addEventListener('click', () => showToast('正在整理任务书与基础图纸…'));
document.querySelector('#skillsButton').addEventListener('click', () => showToast('案例与技能库将在完整原型中展开'));
document.querySelector('#outputsButton').addEventListener('click', () => showToast('暂无可下载成果'));
document.querySelectorAll('.tab:not(.is-active)').forEach((button) => button.addEventListener('click', () => {
  showToast(`${button.textContent}将在下一阶段开发`);
}));
document.querySelectorAll('.suggestions button').forEach((button) => button.addEventListener('click', () => {
  chatInput.value = button.textContent;
  chatInput.focus();
}));

const modelContext = document.modelContext;
if (modelContext?.registerTool) {
  const lifecycle = new AbortController();
  Promise.resolve(modelContext.registerTool({
    name: 'start_ppt_draft',
    title: '开始生成方案 PPT 草案',
    description: '在当前冷链产业园项目中启动方案 PPT 草案整理，并同步更新可见界面。',
    inputSchema: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: '本次草案希望重点表达的设计方向。' }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      if (input && (typeof input !== 'object' || Array.isArray(input))) {
        throw new Error('输入必须是对象');
      }
      const focus = input?.focus?.trim();
      showToast(focus ? `正在围绕“${focus}”整理 PPT…` : '正在整理任务书与基础图纸…');
      return { status: 'started', project: '冷链产业园概念方案', focus: focus || null };
    }
  }, { signal: lifecycle.signal })).catch(() => {});
}
