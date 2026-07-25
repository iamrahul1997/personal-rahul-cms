/* ============================================================
   Rahul's CMS — publishes articles to the personal-rahul repo
   via the GitHub API. Vercel redeploys the site automatically
   after every publish.
   ============================================================ */
(function () {
  "use strict";

  var OWNER = "iamrahul1997";
  var REPO = "personal-rahul";
  var BRANCH = "main";
  var API = "https://api.github.com";
  var TOKEN_KEY = "cms_gh_token";

  var state = { index: [], editing: null, imageFile: null, imagePath: null };
  var quill = null;

  /* ---------------- helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function token() { return localStorage.getItem(TOKEN_KEY) || ""; }
  function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
  function b64decode(b64) { return decodeURIComponent(escape(atob(b64.replace(/\n/g, "")))); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function slugify(s) {
    return s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  }
  function setStatus(id, msg, isError) {
    var el = $(id);
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  }
  function monthYear() {
    return new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  /* ---------------- GitHub API ---------------- */
  function gh(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token(),
      "X-GitHub-Api-Version": "2022-11-28",
    }, opts.headers || {});
    return fetch(API + path, opts).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) return res.json().catch(function () { return {}; }).then(function (body) {
        throw new Error("GitHub " + res.status + ": " + (body.message || "request failed"));
      });
      return res.status === 204 ? {} : res.json();
    });
  }
  function getFile(path) {
    return gh("/repos/" + OWNER + "/" + REPO + "/contents/" + path + "?ref=" + BRANCH);
  }
  function putFile(path, base64Content, message, sha) {
    var body = { message: message, content: base64Content, branch: BRANCH };
    if (sha) body.sha = sha;
    return gh("/repos/" + OWNER + "/" + REPO + "/contents/" + path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }
  function putText(path, text, message) {
    return getFile(path).then(function (existing) {
      return putFile(path, b64encode(text), message, existing && existing.sha);
    });
  }
  function deletePath(path, message) {
    return getFile(path).then(function (existing) {
      if (!existing) return null;
      return gh("/repos/" + OWNER + "/" + REPO + "/contents/" + path, {
        method: "DELETE",
        body: JSON.stringify({ message: message, sha: existing.sha, branch: BRANCH }),
      });
    });
  }

  /* ---------------- views ---------------- */
  function show(view) {
    ["view-settings", "view-list", "view-editor"].forEach(function (v) {
      $(v).hidden = v !== view;
    });
  }

  function loadIndex() {
    return getFile("content/index.json").then(function (file) {
      state.index = file ? JSON.parse(b64decode(file.content)) : [];
      return state.index;
    });
  }

  function renderList() {
    var box = $("article-rows");
    box.innerHTML = "";
    state.index.forEach(function (a) {
      var row = document.createElement("div");
      row.className = "row-card";
      row.innerHTML =
        '<div><div class="title">' + esc(a.title) + '</div>' +
        '<div class="meta">' + esc(a.category) + " · " + esc(a.date) + " · " + a.minutes + " min</div></div>" +
        (a.featured ? '<span class="badge">Featured</span>' : "") +
        '<span class="spacer"></span>' +
        '<a class="btn" href="https://personal-rahul.vercel.app/articles/' + a.slug + '" target="_blank" rel="noopener">View</a>' +
        '<button class="btn" data-edit="' + a.slug + '" type="button">Edit</button>' +
        '<button class="btn btn-danger" data-del="' + a.slug + '" type="button">Delete</button>';
      box.appendChild(row);
    });
  }

  function categoryOptions(selected) {
    var cats = [];
    state.index.forEach(function (a) {
      if (cats.indexOf(a.category) === -1) cats.push(a.category);
    });
    if (!cats.length) cats = ["Geopolitics", "Technology", "Nepal"];
    var sel = $("f-category");
    sel.innerHTML = cats.map(function (c) {
      return '<option' + (c === selected ? " selected" : "") + ">" + esc(c) + "</option>";
    }).join("");
  }

  function openEditor(article) {
    state.editing = article ? article.slug : null;
    state.imageFile = null;
    state.imagePath = article ? article.image : null;
    $("editor-title").textContent = article ? "Edit article" : "New article";
    $("f-title").value = article ? article.title : "";
    $("f-slug").value = article ? article.slug : "";
    $("f-slug").disabled = !!article;
    $("f-date").value = article ? article.date : monthYear();
    $("f-minutes").value = article ? article.minutes : "";
    $("f-excerpt").value = article ? article.excerpt : "";
    $("f-featured").checked = article ? !!article.featured : false;
    $("f-meta-title").value = article ? (article.metaTitle || "") : "";
    $("f-meta-desc").value = article ? (article.metaDescription || "") : "";
    $("f-new-category").value = "";
    categoryOptions(article ? article.category : undefined);
    $("image-preview").hidden = !state.imagePath;
    if (state.imagePath) $("image-preview").src = "https://personal-rahul.vercel.app" + state.imagePath;
    $("image-note").textContent = state.imagePath ? "Current image shown. Choose a file to replace it." : "";
    $("f-image").value = "";
    quill.setContents([]);
    setStatus("editor-status", "");
    if (article) {
      setStatus("editor-status", "Loading content…");
      getFile("content/articles/" + article.slug + ".json").then(function (file) {
        var doc = JSON.parse(b64decode(file.content));
        quill.clipboard.dangerouslyPasteHTML(doc.html || "");
        setStatus("editor-status", "");
      }).catch(function (e) { setStatus("editor-status", e.message, true); });
    }
    show("view-editor");
  }

  /* ---------------- article page template ---------------- */
  function pageTemplate(doc) {
    var metaTitle = doc.metaTitle || (doc.title + " — Rahul Poudel");
    var metaDesc = doc.metaDescription || doc.excerpt;
    var cover = doc.image
      ? '\n      <div class="section-shell">\n        <img class="article-cover" src="' + doc.image + '" alt="" />\n      </div>'
      : "";
    var og = doc.image ? '\n    <meta property="og:image" content="https://personal-rahul.vercel.app' + doc.image + '" />' : "";
    return '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <meta name="description" content="' + esc(metaDesc) + '" />\n    <title>' + esc(metaTitle) + '</title>\n    <meta property="og:title" content="' + esc(metaTitle) + '" />\n    <meta property="og:description" content="' + esc(metaDesc) + '" />' + og + '\n    <link rel="preconnect" href="https://fonts.googleapis.com" />\n    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n    <link\n      href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,500;6..72,600;6..72,700&display=swap"\n      rel="stylesheet"\n    />\n    <link rel="icon" type="image/jpeg" href="../assets/rahul-portrait.jpg" />\n    <link rel="stylesheet" href="../styles.css" />\n  </head>\n  <body>\n    <a class="skip-link" href="#main">Skip to content</a>\n\n    <div class="nav-wrap">\n      <header class="site-header">\n        <a class="brand" href="/" aria-label="Rahul Poudel home">\n          <img class="brand-mark" src="../assets/rahul-portrait.jpg" alt="" />\n          <span>Rahul Poudel</span>\n        </a>\n        <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="primary-nav">\n          <span></span><span></span>\n          <span class="sr-only">Open menu</span>\n        </button>\n        <nav id="primary-nav" class="primary-nav" aria-label="Primary navigation">\n          <a href="/">Home</a>\n          <a href="/writing" aria-current="page">Writing</a>\n          <a href="/about">About</a>\n          <a href="/contact" class="nav-cta">Let\'s talk <span aria-hidden="true">↗</span></a>\n        </nav>\n      </header>\n    </div>\n\n    <main id="main">\n      <header class="article-hero section-shell">\n        <p class="eyebrow">' + esc(doc.category) + '</p>\n        <h1>' + esc(doc.title) + '</h1>\n        <div class="article-byline">\n          <span>By Rahul Poudel</span><span class="dot"></span>\n          <span>' + esc(doc.date) + '</span><span class="dot"></span>\n          <span>' + doc.minutes + ' min read</span>\n        </div>\n      </header>' + cover + '\n\n      <article class="article-body section-shell">\n' + doc.html + '\n      </article>\n\n      <div class="article-footer section-shell">\n        <a class="text-link" href="/writing"><span aria-hidden="true">←</span> All writing</a>\n        <a class="text-link" href="/contact">Discuss this essay <span aria-hidden="true">→</span></a>\n      </div>\n    </main>\n\n    <!-- ===== Newsletter ===== -->\n    <section class="newsletter">\n      <div class="halftone ht-news" aria-hidden="true"></div>\n      <div class="section-shell newsletter-inner" data-reveal>\n        <p class="eyebrow">Newsletter</p>\n        <h2>Get new essays in your inbox.</h2>\n        <p class="newsletter-blurb">No spam. Just geopolitics, technology, and Nepal—when there\'s something worth reading.</p>\n        <form class="newsletter-form" data-newsletter novalidate>\n          <label class="sr-only" for="nl-email">Email address</label>\n          <input id="nl-email" name="email" type="email" required placeholder="you@example.com" autocomplete="email" />\n          <button class="button button-primary" type="submit">Subscribe</button>\n        </form>\n        <p class="form-note" role="status" aria-live="polite"></p>\n      </div>\n    </section>\n\n    <footer class="site-footer">\n      <div class="section-shell footer-inner">\n        <div>\n          <a class="brand" href="/"><img class="brand-mark" src="../assets/rahul-portrait.jpg" alt="" /><span>Rahul Poudel</span></a>\n          <p>Global affairs, Nepal, and technology. © <span id="year"></span> Rahul Poudel</p>\n        </div>\n        <nav aria-label="Footer">\n          <a href="/writing">Writing</a>\n          <a href="/about">About</a>\n          <a href="/contact">Contact</a>\n          <a href="https://instagram.com/rahul.poudel_" target="_blank" rel="noopener">Instagram <span aria-hidden="true">↗</span></a>\n          <a href="https://github.com/iamrahul1997" target="_blank" rel="noopener">GitHub <span aria-hidden="true">↗</span></a>\n        </nav>\n      </div>\n    </footer>\n\n    <script src="../script.js"></script>\n  </body>\n</html>\n';
  }

  /* ---------------- publish pipeline ---------------- */
  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1]); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function publish() {
    var title = $("f-title").value.trim();
    var slug = state.editing || slugify($("f-slug").value.trim() || title);
    var newCat = $("f-new-category").value.trim();
    var category = newCat || $("f-category").value;
    var html = quill.getSemanticHTML().trim();
    var text = quill.getText().trim();
    if (!title || !slug) return setStatus("editor-status", "Title (and slug) are required.", true);
    if (!category) return setStatus("editor-status", "Pick or create a category.", true);
    if (text.length < 40) return setStatus("editor-status", "The article body looks empty.", true);

    var minutes = parseInt($("f-minutes").value, 10) || Math.max(1, Math.round(text.split(/\s+/).length / 200));
    var doc = {
      slug: slug,
      title: title,
      category: category,
      date: $("f-date").value.trim() || monthYear(),
      minutes: minutes,
      excerpt: $("f-excerpt").value.trim() || text.slice(0, 160).trim() + "…",
      featured: $("f-featured").checked,
      image: state.imagePath,
      metaTitle: $("f-meta-title").value.trim() || null,
      metaDescription: $("f-meta-desc").value.trim() || null,
    };

    var btn = $("publish");
    btn.disabled = true;
    var chain = Promise.resolve();

    if (state.imageFile) {
      chain = chain.then(function () {
        setStatus("editor-status", "Uploading feature image…");
        var ext = (state.imageFile.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
        var path = "assets/uploads/" + slug + "-cover-" + Date.now() + "." + ext;
        return readFileAsBase64(state.imageFile).then(function (b64) {
          return putFile(path, b64, "CMS: upload image for " + slug);
        }).then(function () {
          doc.image = "/" + path;
        });
      });
    }

    chain
      .then(function () {
        setStatus("editor-status", "Saving article content…");
        doc.html = html;
        return putText("content/articles/" + slug + ".json", JSON.stringify(doc, null, 2) + "\n", "CMS: save " + slug);
      })
      .then(function () {
        setStatus("editor-status", "Generating article page…");
        return putText("articles/" + slug + ".html", pageTemplate(doc), "CMS: publish page for " + slug);
      })
      .then(function () {
        setStatus("editor-status", "Updating article index…");
        return loadIndex().then(function (list) {
          var entry = {
            slug: doc.slug, title: doc.title, category: doc.category, date: doc.date,
            minutes: doc.minutes, excerpt: doc.excerpt, featured: doc.featured,
            image: doc.image, metaTitle: doc.metaTitle, metaDescription: doc.metaDescription,
          };
          var i = list.findIndex(function (a) { return a.slug === slug; });
          if (i >= 0) list[i] = entry; else list.unshift(entry);
          if (entry.featured) list.forEach(function (a) { if (a.slug !== slug) a.featured = false; });
          return putText("content/index.json", JSON.stringify(list, null, 2) + "\n", "CMS: update index for " + slug);
        });
      })
      .then(function () {
        setStatus("editor-status", "✅ Published! Vercel is deploying — live in ~30 seconds at /articles/" + slug);
        state.editing = slug;
        $("f-slug").disabled = true;
        state.imageFile = null;
      })
      .catch(function (e) { setStatus("editor-status", e.message, true); })
      .then(function () { btn.disabled = false; });
  }

  function removeArticle(slug) {
    if (!confirm("Delete “" + slug + "” from the site? This removes the page and the article data.")) return;
    setStatus("list-status", "Deleting…");
    loadIndex()
      .then(function (list) {
        var next = list.filter(function (a) { return a.slug !== slug; });
        return putText("content/index.json", JSON.stringify(next, null, 2) + "\n", "CMS: remove " + slug + " from index");
      })
      .then(function () { return deletePath("content/articles/" + slug + ".json", "CMS: delete content for " + slug); })
      .then(function () { return deletePath("articles/" + slug + ".html", "CMS: delete page for " + slug); })
      .then(function () { return loadIndex(); })
      .then(function () { renderList(); setStatus("list-status", "Deleted. Vercel is redeploying the site."); })
      .catch(function (e) { setStatus("list-status", e.message, true); });
  }

  /* ---------------- wiring ---------------- */
  function goList() {
    setStatus("list-status", "Loading…");
    loadIndex().then(function () {
      renderList();
      setStatus("list-status", "");
      show("view-list");
    }).catch(function (e) {
      setStatus("list-status", e.message + " — check your token in Settings.", true);
      show("view-list");
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    quill = new Quill("#quill", {
      theme: "snow",
      placeholder: "Write your essay…",
      modules: {
        toolbar: {
          container: [
            [{ header: 2 }],
            ["bold", "italic", "underline", "link"],
            ["blockquote"],
            [{ list: "ordered" }, { list: "bullet" }],
            ["image"],
            ["clean"],
          ],
          handlers: {
            image: function () {
              var input = document.createElement("input");
              input.type = "file";
              input.accept = "image/*";
              input.onchange = function () {
                var f = input.files[0];
                if (!f) return;
                setStatus("editor-status", "Uploading inline image…");
                var ext = (f.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
                var path = "assets/uploads/inline-" + Date.now() + "." + ext;
                readFileAsBase64(f).then(function (b64) {
                  return putFile(path, b64, "CMS: upload inline image");
                }).then(function () {
                  var range = quill.getSelection(true);
                  quill.insertEmbed(range.index, "image", "/" + path);
                  setStatus("editor-status", "");
                }).catch(function (e) { setStatus("editor-status", e.message, true); });
              };
              input.click();
            },
          },
        },
      },
    });

    $("nav-articles").onclick = goList;
    $("nav-settings").onclick = function () {
      $("token").value = token();
      show("view-settings");
    };
    $("save-token").onclick = function () {
      localStorage.setItem(TOKEN_KEY, $("token").value.trim());
      setStatus("settings-status", "Token saved in this browser.");
    };
    $("test-token").onclick = function () {
      setStatus("settings-status", "Testing…");
      localStorage.setItem(TOKEN_KEY, $("token").value.trim());
      gh("/repos/" + OWNER + "/" + REPO).then(function (repo) {
        setStatus("settings-status", repo ? "✅ Connected to " + repo.full_name : "Repo not found — token may lack access.", !repo);
      }).catch(function (e) { setStatus("settings-status", e.message, true); });
    };
    $("new-article").onclick = function () { openEditor(null); };
    $("back-to-list").onclick = goList;
    $("publish").onclick = publish;
    $("f-title").addEventListener("input", function () {
      if (!state.editing) $("f-slug").value = slugify($("f-title").value);
    });
    $("f-image").addEventListener("change", function () {
      var f = $("f-image").files[0];
      state.imageFile = f || null;
      if (f) {
        $("image-preview").src = URL.createObjectURL(f);
        $("image-preview").hidden = false;
        $("image-note").textContent = f.name;
      }
    });
    $("article-rows").addEventListener("click", function (e) {
      var edit = e.target.closest("[data-edit]");
      var del = e.target.closest("[data-del]");
      if (edit) {
        var a = state.index.find(function (x) { return x.slug === edit.dataset.edit; });
        if (a) openEditor(a);
      } else if (del) {
        removeArticle(del.dataset.del);
      }
    });

    if (token()) goList(); else show("view-settings");
  });
})();
