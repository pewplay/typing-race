/*
 * Typing Race
 * A responsive rebuild of "Eat My Dust!" by Junsik Shim and Juhyun Choi (artwork by wabie),
 * made for js13kGames 2019. MIT License - see LICENSE.
 *
 * Type the story as fast and as accurately as you can: every correct letter pushes your runner
 * forward. On your first run of a story you race a bot; after that you race the "ghosts" of your
 * own best runs, which are replayed keystroke by keystroke.
 *
 * Plain script (no modules), so the game also works when opened straight from disk.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ constants

  var STORAGE_PREFIX = 'typing-race:';

  var SCENE_H = 324;        // logical height of the track (sky 0..270, grass/dirt strip 270..324)
  var GROUND_Y = 270;
  var CHAR_W = 100;
  var CHAR_H = 100;
  var STEP = 1000 / 60;     // fixed simulation step (ms)

  var ACTION_CORRECT = 1;
  var ACTION_INCORRECT = 2;
  var ACTION_FINISH = 3;

  var MODE_NORMAL = 0;
  var MODE_SKILL = 1;

  var ACCELERATE_SPEED = 3;
  var DECELERATE_SPEED = 0.2;
  var MAX_SPEED = 10;
  var SKILL_SPEED = 20;
  var ENERGY_GAIN = 2;
  var SKILL_FRAMES = 210;   // 3.5 seconds
  var SKILL_BONUS = 200;    // +1m for each correct letter typed while the skill is active
  var PX_PER_METER = 200;

  var MAX_SAVED = 10;       // records kept per story
  var MAX_GHOSTS = 3;       // best records raced against

  var STORIES = [
    {
      id: 'the-hare-and-the-tortoise',
      title: 'The Hare and the Tortoise',
      text: 'Once, a hare saw a tortoise walking slowly with a heavy shell on his back. The hare was very proud of himself, and he asked the tortoise, "Shall we have a race?" The tortoise agreed. They started the race. The hare ran very fast, but the tortoise walked very slowly. The proud hare rested under a tree and soon fell asleep. But the tortoise kept walking, slowly and steadily, and reached the goal. At last, the tortoise won the race.'
    },
    {
      id: 'the-sick-lion',
      title: 'The Sick Lion',
      text: 'A lion, unable from old age and infirmities to provide himself with food by force, resolved to do so by artifice. He returned to his den, and lying down there, pretended to be sick, taking care that his sickness should be publicly known. The beasts expressed their sorrow, and came one by one to his den, where the lion devoured them. After many of the beasts had thus disappeared, the fox discovered the trick and presenting himself to the lion, stood on the outside of the cave, at a respectful distance, and asked him how he was. "I am very middling," replied the lion, "but why do you stand without? Pray enter within to talk with me." "No, thank you," said the fox. "I notice that there are many prints of feet entering your cave, but I see no trace of any returning."'
    },
    {
      id: 'the-shepherds-boy-and-the-wolf',
      title: "The Shepherd's Boy and the Wolf",
      text: 'A shepherd boy, who watched a flock of sheep near a village, brought out the villagers three or four times by crying out, "Wolf! Wolf!" and when his neighbors came to help him, laughed at them for their pains. The wolf, however, did truly come at last. The shepherd boy, now really alarmed, shouted in an agony of terror: "Pray, do come and help me; the wolf is killing the sheep!" But no one paid any heed to his cries, nor rendered any assistance. The wolf, having no cause of fear, at his leisure destroyed the whole flock.'
    }
  ];

  STORIES.forEach(function (s) {
    s.text = s.text.replace(/\s+/g, ' ').trim();
  });

  // ------------------------------------------------------------------ helpers

  var $ = function (id) { return document.getElementById(id); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var rnd = Math.random;
  var formatMeters = function (d) { return d.toFixed(2) + 'm'; };
  var ordinal = function (n) {
    var s = ['th', 'st', 'nd', 'rd'];
    var v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  // ------------------------------------------------------------------ storage (records = ghosts)

  var storage = {
    get: function (key) {
      try { return window.localStorage.getItem(STORAGE_PREFIX + key); } catch (e) { return null; }
    },
    set: function (key, value) {
      try { window.localStorage.setItem(STORAGE_PREFIX + key, value); } catch (e) { /* storage unavailable */ }
    }
  };

  // A record: { d: final distance in meters, n: ISO date, l: [frameDiff, action, frameDiff, action, ...] }
  function loadRecords(storyId) {
    var raw = storage.get('records:' + storyId);
    if (!raw) return [];
    try {
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter(function (r) { return r && Array.isArray(r.l) && typeof r.d === 'number'; }) : [];
    } catch (e) {
      return [];
    }
  }

  function saveRecord(storyId, record) {
    var list = loadRecords(storyId);
    list.push(record);
    list.sort(function (a, b) { return b.d - a.d; });
    storage.set('records:' + storyId, JSON.stringify(list.slice(0, MAX_SAVED)));
  }

  // The bot types every letter 100-300ms apart and makes a typo about 1% of the time.
  function makeBotLog(length) {
    var list = [0, ACTION_CORRECT];
    for (var i = 0; i < length - 1; i++) {
      list.push(6 + Math.floor(rnd() * 12), rnd() * 100 < 1 ? ACTION_INCORRECT : ACTION_CORRECT);
    }
    list.push(0, ACTION_FINISH);
    return { d: -1, l: list, isBot: true };
  }

  // ------------------------------------------------------------------ assets

  var images = {};

  function loadImages(names) {
    return Promise.all(names.map(function (name) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { images[name] = img; resolve(); };
        img.onerror = reject;
        img.src = 'images/' + name + '.png';
      });
    }));
  }

  // ------------------------------------------------------------------ sprite animation

  // Frame-based animation for the 32x32 runner sheet (images/m.png, 20 frames).
  function Animation(frames, frameRate) {
    this.frames = frames;
    this.frameRate = frameRate;
    this.f = 0;
    this.a = 0;
  }
  Animation.prototype.update = function () {
    this.a += 1 / 60;
    while (this.frameRate > 0 && this.a * this.frameRate >= 1) {
      this.f = (this.f + 1) % this.frames.length;
      this.a -= 1 / this.frameRate;
    }
  };
  Animation.prototype.frame = function () { return this.frames[this.f]; };

  function range(a, b) { var r = []; for (var i = a; i <= b; i++) r.push(i); return r; }

  function makeRunnerAnimations(runRate) {
    return {
      run: new Animation(range(0, 9), runRate || 10),
      stand: new Animation([3, 8], 3),
      skill: new Animation(range(10, 19), 15)
    };
  }

  function drawRunnerFrame(ctx, frame, x, y, w, h) {
    ctx.drawImage(images.m, frame * 32, 0, 32, 32, x, y, w || CHAR_W, h || CHAR_H);
  }

  // ------------------------------------------------------------------ runner physics

  // Shared by the player, the ghosts and the bot, so a replayed run lands on exactly the same distance.
  function Runner(withAnimations) {
    this.x = 0;
    this.dx = 0;
    this.E = 0;           // energy 0..100
    this.mode = MODE_NORMAL;
    this.skillT = 0;
    this.boost = 0;       // bonus distance still to be covered
    this.anims = withAnimations ? makeRunnerAnimations() : null;
    this.anim = this.anims ? this.anims.stand : null;
    this.onSkillStart = null;
    this.onSkillEnd = null;
  }

  Runner.prototype.play = function (name) {
    if (this.anims) this.anim = this.anims[name];
  };

  Runner.prototype.acc = function () {
    if (this.mode !== MODE_NORMAL) return;
    this.dx = Math.min(this.dx + ACCELERATE_SPEED, MAX_SPEED);
    if (this.anims) this.anims.run.frameRate = Math.min(this.dx, 10);
  };

  Runner.prototype.dec = function () {
    if (this.mode !== MODE_NORMAL) return;
    this.dx = Math.max(this.dx - DECELERATE_SPEED, 0);
    if (this.anims) this.anims.run.frameRate = Math.max(this.dx, 0);
  };

  Runner.prototype.useSkill = function () {
    this.mode = MODE_SKILL;
    this.dx = SKILL_SPEED;
    this.skillT = SKILL_FRAMES;
    this.play('skill');
    if (this.onSkillStart) this.onSkillStart();
  };

  // A correct letter: gain energy and speed, or a +1m bonus while the skill is active.
  Runner.prototype.correct = function () {
    if (this.mode === MODE_SKILL) {
      this.boost += SKILL_BONUS;
      return true;
    }
    this.E += ENERGY_GAIN;
    if (this.E >= 100) this.useSkill();
    this.acc();
    return false;
  };

  // A typo empties the energy bar (but cannot stop an active skill).
  Runner.prototype.typo = function () {
    if (this.mode !== MODE_NORMAL) return false;
    var had = this.E > 0;
    this.E = 0;
    return had;
  };

  Runner.prototype.update = function () {
    this.x += this.dx;

    if (this.boost > 0) {
      var s = Math.min(this.boost, Math.max(2, this.boost * 0.12));
      this.x += s;
      this.boost -= s;
      if (this.boost < 0.01) this.boost = 0;
    }

    if (this.mode === MODE_SKILL) {
      if (--this.skillT <= 0) {
        this.mode = MODE_NORMAL;
        this.E = 0;
        if (this.onSkillEnd) this.onSkillEnd();
      }
    } else {
      this.play(this.dx < 0.2 ? 'stand' : 'run');
    }

    if (this.anim) this.anim.update();
  };

  Runner.prototype.isStopped = function () {
    return this.mode === MODE_NORMAL && this.dx === 0 && this.boost === 0;
  };

  Runner.prototype.meters = function () {
    return Math.round(this.x / PX_PER_METER * 100) / 100;
  };

  // Replays a recorded run.
  function Replay(log) {
    this.events = [];
    var t = 0;
    for (var i = 0; i + 1 < log.l.length; i += 2) {
      t += log.l[i];
      this.events.push({ t: t, a: log.l[i + 1] });
    }
    this.i = 0;
  }
  Replay.prototype.apply = function (runner, rel) {
    while (this.i < this.events.length && this.events[this.i].t < rel) {
      var a = this.events[this.i++].a;
      if (a === ACTION_CORRECT) runner.correct();
      else if (a === ACTION_INCORRECT) runner.typo();
    }
  };
  Replay.prototype.done = function () { return this.i >= this.events.length; };

  // Final distance of a recorded run (used to rank against the bot).
  function simulateDistance(log) {
    var r = new Runner(false);
    var rep = new Replay(log);
    for (var rel = 1; rel < 2e6; rel++) {
      rep.apply(r, rel);
      r.dec();
      r.update();
      if (rep.done() && r.isStopped()) break;
    }
    return r.meters();
  }

  // ------------------------------------------------------------------ title logo (pixel font)

  var GLYPHS = {
    T: ['#####', '..#..', '..#..', '..#..', '..#..'],
    Y: ['#...#', '.#.#.', '..#..', '..#..', '..#..'],
    P: ['####.', '#...#', '####.', '#....', '#....'],
    I: ['###', '.#.', '.#.', '.#.', '###'],
    N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
    G: ['.####', '#....', '#..##', '#...#', '.###.'],
    R: ['####.', '#...#', '####.', '#..#.', '#...#'],
    A: ['.###.', '#...#', '#####', '#...#', '#...#'],
    C: ['.####', '#....', '#....', '#....', '.####'],
    E: ['#####', '#....', '####.', '#....', '#####'],
    ' ': ['..', '..', '..', '..', '..']
  };

  // White letters with a blue drop shadow, like the original logo. 1 canvas pixel = 1 logo pixel.
  function makePixelText(text, face, shadow) {
    var w = 1;
    var i;
    for (i = 0; i < text.length; i++) w += GLYPHS[text[i]][0].length + (i < text.length - 1 ? 1 : 0);
    var c = document.createElement('canvas');
    c.width = w;
    c.height = 6;
    var g = c.getContext('2d');
    [[0, 1, shadow], [1, 0, face]].forEach(function (pass) {
      var x = pass[0];
      g.fillStyle = pass[2];
      for (var k = 0; k < text.length; k++) {
        var rows = GLYPHS[text[k]];
        for (var yy = 0; yy < 5; yy++) {
          for (var xx = 0; xx < rows[yy].length; xx++) {
            if (rows[yy][xx] === '#') g.fillRect(x + xx, pass[1] + yy, 1, 1);
          }
        }
        x += rows[0].length + 1;
      }
    });
    return c;
  }

  var logo = null;

  // ------------------------------------------------------------------ DOM

  var body = document.body;
  var app = $('app');
  var canvas = $('canvas');
  var ctx = canvas.getContext('2d');
  var kbd = $('kbd');

  var dom = {
    distance: $('distance-value'),
    energyFrame: $('energy-frame'),
    energyBar: $('energy-bar'),
    startMsg: $('start-msg'),
    textbox: $('textbox'),
    line: $('line'),
    next: $('next-line'),
    resultTitle: $('result-title'),
    resultDistance: $('result-distance'),
    resultDetail: $('result-detail'),
    storyList: $('story-list')
  };

  // Persistent nodes of the current line: [typed][cursor][rest]
  var lineTyped = document.createElement('span');
  var lineCursor = document.createElement('span');
  var lineRest = document.createTextNode('');
  lineTyped.className = 'correct';
  lineCursor.className = 'cursor';
  dom.line.appendChild(lineTyped);
  dom.line.appendChild(lineCursor);
  dom.line.appendChild(lineRest);

  var isTouch = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  // ------------------------------------------------------------------ layout

  var view = {
    vw: 0, vh: 0,
    s: 1,            // CSS px per logical px of the track
    sh: 0,           // track height in CSS px
    W: 960,          // logical width of the track
    dpr: 1,
    offX: 300,       // where the player stands
    chars: 40        // characters per typing line
  };

  var charRatio = 0.6;
  var monoFont = 'monospace';

  function measureCharRatio() {
    monoFont = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace';
    var c = document.createElement('canvas').getContext('2d');
    c.font = '100px ' + monoFont;
    var w = c.measureText('MMMMMMMMMM').width / 1000;
    if (w > 0.3 && w < 1) charRatio = w;
    document.documentElement.style.setProperty('--cw', charRatio.toFixed(3));
  }

  function layout() {
    var vv = window.visualViewport;
    var vw = Math.round(vv ? vv.width : window.innerWidth) || window.innerWidth;
    var vh = Math.round(vv ? vv.height : window.innerHeight) || window.innerHeight;
    app.style.left = (vv ? vv.offsetLeft : 0) + 'px';
    app.style.top = (vv ? vv.offsetTop : 0) + 'px';
    app.style.width = vw + 'px';
    app.style.height = vh + 'px';

    // Typing text: as large as possible while 40 characters fit; on narrow screens keep at least 20px
    // and use shorter lines instead.
    var boxMax = Math.min(vw - 24, 1400);
    var fit = function (f) { return Math.floor((boxMax - 1.4 * f - 2) / (charRatio * f)); };
    var panelNeed = function (f) { return f * 3.7 + 26; };
    var f = Math.round(clamp(vh * 0.045, 32, 44));
    while (f > 20 && fit(f) < 40) f--;
    var minScene = Math.min(110, vh * 0.4);
    while (f > 13 && vh - panelNeed(f) < minScene) f--;
    view.chars = clamp(fit(f), 12, 40);

    var s = Math.min(vw / (vw < vh ? 420 : 540), (vh - panelNeed(f)) / SCENE_H, vh * 0.62 / SCENE_H);
    s = Math.max(s, 0.12);
    var sh = Math.round(SCENE_H * s);
    s = sh / SCENE_H;

    body.classList.toggle('narrow', vw < 560);

    view.vw = vw;
    view.vh = vh;
    view.s = s;
    view.sh = sh;
    view.W = vw / s;
    view.offX = Math.round(clamp(view.W * 0.3, 110, 300));
    view.dpr = Math.min(window.devicePixelRatio || 1, 3);

    var root = document.documentElement.style;
    root.setProperty('--sh', sh + 'px');
    root.setProperty('--f', f + 'px');
    root.setProperty('--chars', view.chars);
    root.setProperty('--hud', Math.round(clamp(sh * 0.052, 13, 28)) + 'px');

    canvas.width = Math.max(1, Math.round(vw * view.dpr));
    canvas.height = Math.max(1, Math.round(sh * view.dpr));

    // "Type to start!" hovers above the player's head
    var msgSize = parseFloat(getComputedStyle(dom.startMsg).fontSize) || 16;
    dom.startMsg.style.left = ((view.offX + 50) * s) + 'px';
    dom.startMsg.style.top = Math.round(168 * s - msgSize * 1.5) + 'px';
    dom.startMsg.style.visibility = 168 * s - msgSize * 1.5 > 44 ? 'visible' : 'hidden';

    if (current && current.relayout) current.relayout();
    render();
  }

  // ------------------------------------------------------------------ shared scenery

  function Scenery() {
    this.clouds = [];
    this.dust = [];
    this.wind = [];
    this.cloudT = 0;
    this.groundX = 0;
    // a few clouds already in the sky
    for (var i = 0; i < 4; i++) this.addCloud(rnd() * view.W);
  }

  Scenery.prototype.addCloud = function (x) {
    var dx = -(rnd() * 2 + 0.3);
    this.clouds.push({ x: x, y: rnd() * 100 + 20, dx: dx });
  };

  Scenery.prototype.addDust = function () {
    if (this.dust.length > 120) return;
    var size = rnd() * 5;
    this.dust.push({
      x: view.offX + CHAR_W / 2 - 20,
      y: GROUND_Y - 2,
      dx: -rnd() - 1,
      dy: -rnd() * 0.5,
      size: size,
      ttl: 100
    });
  };

  Scenery.prototype.addWindBurst = function () {
    for (var i = 0; i < 15; i++) this.wind.push({ delay: i * 12, age: 0, x: 0, y: 0, o: 0, placed: false });
  };

  Scenery.prototype.update = function (cloudSpeed) {
    var i;
    if (--this.cloudT <= 0) {
      this.addCloud(view.W + 10);
      this.cloudT = 120 + Math.floor(rnd() * 60);
    }
    for (i = this.clouds.length - 1; i >= 0; i--) {
      var c = this.clouds[i];
      c.x += c.dx * cloudSpeed;
      if (c.x < -60) this.clouds.splice(i, 1);
    }
    for (i = this.dust.length - 1; i >= 0; i--) {
      var d = this.dust[i];
      d.x += d.dx;
      d.y += d.dy;
      if (--d.ttl <= 0) this.dust.splice(i, 1);
    }
    for (i = this.wind.length - 1; i >= 0; i--) {
      var w = this.wind[i];
      if (w.delay > 0) { w.delay--; continue; }
      if (!w.placed) {
        w.placed = true;
        w.x = rnd() * view.W;
        w.y = rnd() * 230 + 30;
        w.o = rnd() * 0.4 + 0.2;
      }
      if (++w.age > 60) this.wind.splice(i, 1);
    }
  };

  Scenery.prototype.renderBackground = function () {
    ctx.fillStyle = '#5ebfff';
    ctx.fillRect(0, 0, view.W + 2, GROUND_Y + 1);
    ctx.fillStyle = '#936c3e';
    ctx.fillRect(0, GROUND_Y + 20, view.W + 2, SCENE_H - GROUND_Y);
    // grass and dirt strip, 64x54 tile
    var gx = -(((this.groundX % 64) + 64) % 64);
    for (var x = gx; x < view.W + 64; x += 64) ctx.drawImage(images.g, x, GROUND_Y, 64, 54);
  };

  Scenery.prototype.renderFront = function () {
    var i;
    for (i = 0; i < this.clouds.length; i++) {
      var c = this.clouds[i];
      ctx.globalAlpha = clamp(c.dx / -2, 0, 1);
      ctx.drawImage(images.c, c.x, c.y, 52, 32);
    }
    for (i = 0; i < this.dust.length; i++) {
      var d = this.dust[i];
      ctx.globalAlpha = clamp(d.ttl / 80, 0, 1);
      ctx.drawImage(images.d, d.x, d.y, d.size, d.size);
    }
    ctx.fillStyle = '#fff';
    for (i = 0; i < this.wind.length; i++) {
      var w = this.wind[i];
      if (!w.placed) continue;
      var t = clamp((w.age - 6) / 60, 0, 1);
      ctx.globalAlpha = w.o;
      ctx.fillRect(w.x - 1500 * t * t, w.y, 500, 6);
    }
    ctx.globalAlpha = 1;
  };

  // ------------------------------------------------------------------ scenes

  var current = null;
  var scenery = null;

  function setScene(scene, data) {
    if (current && current.exit) current.exit();
    current = scene;
    body.classList.remove('scene-title', 'scene-game', 'finished', 'kbd-off');
    body.classList.add('scene-' + scene.name);
    scene.enter(data);
    render();
  }

  // ---- Title

  var titleScene = {
    name: 'title',
    enter: function () {
      this.anims = makeRunnerAnimations(20);
      this.dustT = 0;
      scenery = new Scenery();
      blurKeyboard();
    },
    exit: function () {},
    update: function () {
      this.anims.run.update();
      if (++this.dustT >= 3) { this.dustT = 0; scenery.addDust(); }
      scenery.groundX += 4;
      scenery.update(1);
    },
    render: function () {
      scenery.renderBackground();
      drawRunnerFrame(ctx, this.anims.run.frame(), view.offX, GROUND_Y - CHAR_H);
      scenery.renderFront();
      // logo: beside the runner if there is room, otherwise above it
      if (!logo) logo = makePixelText('TYPING RACE', '#ffffff', '#0f89ff');
      var u = 6;
      var lw = logo.width * u;
      var lh = logo.height * u;
      var free = view.W - (view.offX + CHAR_W + 30);
      var x;
      var y;
      if (free >= lw + 30) {
        x = view.offX + CHAR_W + 30 + Math.min(40, (free - lw) / 2);
        y = 140;
      } else {
        u = Math.min(6, (view.W - 30) / logo.width);
        lw = logo.width * u;
        lh = logo.height * u;
        x = (view.W - lw) / 2;
        y = Math.max(28, 120 - lh - 20);
      }
      ctx.drawImage(logo, x, y, lw, lh);
    }
  };

  // ---- Story picker (an overlay above the title screen)

  var picker = {
    open: false,
    selected: 0,
    show: function () {
      if (current !== titleScene) setScene(titleScene);
      this.open = true;
      body.classList.add('picker-open');
      this.build();
    },
    hide: function () {
      this.open = false;
      body.classList.remove('picker-open');
    },
    build: function () {
      var list = dom.storyList;
      list.innerHTML = '';
      STORIES.forEach(function (story, i) {
        var li = document.createElement('li');
        var name = document.createElement('span');
        name.textContent = (i + 1) + '. ' + story.title;
        var best = document.createElement('span');
        best.className = 'best';
        var recs = loadRecords(story.id);
        best.textContent = recs.length ? 'Best ' + formatMeters(recs[0].d) : 'vs Bot';
        li.appendChild(name);
        li.appendChild(best);
        li.addEventListener('click', function () { picker.start(i); });
        li.addEventListener('pointermove', function (e) {
          if (e.pointerType === 'mouse' && picker.selected !== i) { picker.selected = i; picker.mark(); }
        });
        list.appendChild(li);
      });
      this.mark();
    },
    mark: function () {
      var items = dom.storyList.children;
      for (var i = 0; i < items.length; i++) items[i].classList.toggle('s', i === this.selected);
      var el = items[this.selected];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    },
    move: function (d) {
      this.selected = (this.selected + d + STORIES.length) % STORIES.length;
      this.mark();
    },
    start: function (i) {
      this.selected = i;
      this.hide();
      startGame(STORIES[i]);
    }
  };

  // ---- Race

  var gameScene = {
    name: 'game',

    enter: function (story) {
      var G = this;
      G.story = story;
      G.text = story.text;
      G.cursor = 0;
      G.lineStart = 0;
      G.lineEnd = 0;
      G.nextEnd = 0;
      G.started = false;
      G.finished = false;
      G.done = false;
      G.frame = 0;
      G.startFrame = 0;
      G.lastFrame = 0;
      G.log = { d: 0, n: '', l: [] };
      G.shownE = -1;

      scenery = new Scenery();

      G.player = new Runner(true);
      G.player.onSkillStart = function () { scenery.addWindBurst(); };

      // ghosts: the best saved runs, or the bot on the first run of a story
      var records = loadRecords(story.id).slice(0, MAX_GHOSTS);
      G.vsBot = records.length === 0;
      if (G.vsBot) {
        var bot = makeBotLog(G.text.length);
        bot.d = simulateDistance(bot);
        records = [bot];
      }
      G.records = records;
      G.ghosts = records.map(function (rec, i) {
        return {
          runner: new Runner(true),
          replay: new Replay(rec),
          label: rec.isBot ? 'Bot' : '#' + (i + 1)
        };
      });

      G.lineEnd = lineEndFrom(G.text, 0, view.chars);
      G.nextEnd = lineEndFrom(G.text, G.lineEnd, view.chars);
      G.renderText();
      G.updateHud();

      dom.startMsg.style.display = 'block';
      focusKeyboard();
      updateKeyboardHint();
    },

    exit: function () {
      dom.startMsg.style.display = 'none';
      blurKeyboard();
    },

    relayout: function () {
      // re-flow the lines for the new width (keeps the line being typed if it is already started)
      if (this.cursor === this.lineStart) this.lineEnd = lineEndFrom(this.text, this.lineStart, view.chars);
      this.nextEnd = lineEndFrom(this.text, this.lineEnd, view.chars);
      this.renderText();
    },

    renderText: function () {
      var T = this.text;
      lineTyped.textContent = T.slice(this.lineStart, this.cursor);
      lineCursor.textContent = T.charAt(this.cursor);
      lineRest.textContent = T.slice(this.cursor + 1, this.lineEnd);
      dom.next.textContent = T.slice(this.lineEnd, this.nextEnd);
    },

    type: function (c) {
      var G = this;
      if (G.finished) return;
      var expected = G.text.charAt(G.cursor);
      var player = G.player;

      if (c === expected) {
        if (!G.started) {
          G.started = true;
          G.startFrame = G.frame;
          G.lastFrame = G.frame;
          dom.startMsg.style.display = 'none';
        }

        G.cursor++;
        if (G.cursor >= G.lineEnd) {
          G.lineStart = G.lineEnd;
          G.lineEnd = G.nextEnd;
          G.nextEnd = lineEndFrom(G.text, G.lineEnd, view.chars);
        }

        var bonus = player.correct();
        G.log.l.push(G.frame - G.lastFrame, ACTION_CORRECT);
        scenery.addDust();

        G.renderText();
        if (bonus) showPlus1();

        if (G.cursor >= G.text.length) {
          G.finished = true;
          G.log.l.push(0, ACTION_FINISH);
          blurKeyboard();
          updateKeyboardHint();
        }
      } else {
        if (G.started) {
          if (player.typo()) dropEnergyBar();
          G.log.l.push(G.frame - G.lastFrame, ACTION_INCORRECT);
        }
        flashCursor();
      }

      if (G.started) G.lastFrame = G.frame;
    },

    update: function () {
      var G = this;
      G.frame++;
      var player = G.player;

      if (G.started) {
        var rel = G.frame - G.startFrame;
        G.ghosts.forEach(function (g) {
          g.replay.apply(g.runner, rel);
          g.runner.dec();
          g.runner.update();
        });
      }

      player.dec();
      player.update();

      scenery.groundX = player.x;
      scenery.update(player.mode === MODE_SKILL ? 3 : 1);

      if (G.finished && !G.done && player.isStopped()) G.showResult();
      G.updateHud();
    },

    updateHud: function () {
      var p = this.player;
      dom.distance.textContent = formatMeters(p.x / PX_PER_METER);
      var e = Math.min(p.E, 100);
      if (e !== this.shownE) {
        this.shownE = e;
        dom.energyBar.style.width = e + '%';
      }
    },

    showResult: function () {
      var G = this;
      G.done = true;
      var d = G.player.meters();
      G.log.d = d;
      G.log.n = new Date().toISOString().slice(0, 10);

      var others = G.records.map(function (r) { return r.d; });
      var best = Math.max.apply(null, others);
      var place = 1 + others.filter(function (o) { return o > d; }).length;

      saveRecord(G.story.id, G.log);

      dom.resultDistance.textContent = formatMeters(d);
      if (G.vsBot) {
        dom.resultTitle.textContent = d > best ? 'You beat the Bot!' : 'The Bot wins!';
        dom.resultDetail.textContent = 'Bot: ' + formatMeters(best) + '. Next time you race your own ghost.';
      } else {
        dom.resultTitle.textContent = d > best ? 'New Record!' : 'You ran';
        dom.resultDetail.textContent = ordinal(place) + ' of ' + (others.length + 1) + ' · best before: ' + formatMeters(best);
      }
      body.classList.add('finished');
    },

    render: function () {
      var G = this;
      var player = G.player;
      scenery.renderBackground();

      // ghosts are drawn translucent behind the player
      ctx.globalAlpha = 0.4;
      G.ghosts.forEach(function (g) {
        var x = g.runner.x - player.x + view.offX;
        if (x > -CHAR_W && x < view.W) drawRunnerFrame(ctx, g.runner.anim.frame(), x, GROUND_Y - CHAR_H);
      });
      ctx.globalAlpha = 1;

      drawRunnerFrame(ctx, player.anim.frame(), view.offX, GROUND_Y - CHAR_H);

      if (G.started) {
        // labels that would overlap (e.g. several ghosts off screen on the same side) are stacked
        var labels = G.ghosts.map(function (g) {
          var cx = g.runner.x - player.x + view.offX + CHAR_W / 2;
          return { g: g, cx: cx, lx: clamp(cx, 60, view.W - 60), row: 0 };
        }).sort(function (a, b) { return a.lx - b.lx; });
        labels.forEach(function (l, i) {
          if (i > 0 && l.lx - labels[i - 1].lx < 56) l.row = labels[i - 1].row + 1;
          drawGhostLabel(l);
        });
      }

      scenery.renderFront();
    }
  };

  // Label ("Bot", "#1"...) with an arrow pointing at the ghost, kept on screen when the ghost is not.
  function drawGhostLabel(l) {
    var y = 130 - l.row * 26;
    ctx.save();
    ctx.font = 'bold 22px ' + monoFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#936c3e';
    ctx.fillText(l.g.label, l.lx + 1, y + 1);
    ctx.fillStyle = '#fff';
    ctx.fillText(l.g.label, l.lx, y);
    if (l.row === 0) {
      // arrow pivots under the label and points at the runner's head
      var angle = clamp(Math.atan2(250 - 120, l.cx - l.lx) - Math.PI / 2, -1.4, 1.4);
      ctx.translate(l.lx, 138);
      ctx.rotate(angle);
      ctx.drawImage(images.a, -7.5, 8, 15, 9);
    }
    ctx.restore();
  }

  function lineEndFrom(text, start, chars) {
    if (start >= text.length) return text.length;
    var end = start;
    var i = start;
    while (i < text.length) {
      var sp = text.indexOf(' ', i);
      var wordStop = sp === -1 ? text.length : sp;
      var next = sp === -1 ? text.length : sp + 1;
      if (wordStop - start > chars && end > start) break;
      end = next;
      i = next;
      if (wordStop - start > chars) break;
    }
    return end;
  }

  // ------------------------------------------------------------------ little effects (DOM)

  function flashCursor() {
    lineCursor.classList.remove('w');
    void lineCursor.offsetWidth; // restart the animation
    lineCursor.classList.add('w');
  }

  function dropEnergyBar() {
    var clone = document.createElement('div');
    clone.className = 'energy-drop';
    clone.style.width = dom.energyBar.style.width;
    dom.energyFrame.appendChild(clone);
    setTimeout(function () { if (clone.parentNode) clone.parentNode.removeChild(clone); }, 1100);
  }

  function showPlus1() {
    var el = document.createElement('span');
    el.className = 'plus1';
    el.textContent = '+1';
    var rect = lineCursor.getBoundingClientRect();
    var box = dom.textbox.getBoundingClientRect();
    el.style.left = Math.max(0, rect.left - box.left - 14) + 'px';
    dom.textbox.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1000);
  }

  // ------------------------------------------------------------------ keyboard / text input

  function focusKeyboard() {
    try { kbd.focus({ preventScroll: true }); } catch (e) { kbd.focus(); }
  }

  function blurKeyboard() {
    kbd.value = '';
    consumed = '';
    if (document.activeElement === kbd) kbd.blur();
  }

  function wantsKeyboard() {
    return current === gameScene && !gameScene.finished;
  }

  function updateKeyboardHint() {
    body.classList.toggle('kbd-off', isTouch && wantsKeyboard() && document.activeElement !== kbd);
  }

  // Phone keyboards often report key "Unidentified" and send text through input events instead,
  // so the hidden field is read as a stream: every new character appended to it is typed.
  var consumed = '';
  var composing = false;

  function normalizeChar(c) {
    if (c === '‘' || c === '’' || c === 'ʼ') return "'";
    if (c === '“' || c === '”') return '"';
    if (c === ' ') return ' ';
    return c;
  }

  function typeChars(str) {
    if (!wantsKeyboard()) return;
    for (var i = 0; i < str.length; i++) gameScene.type(normalizeChar(str[i]));
  }

  kbd.addEventListener('input', function () {
    var v = kbd.value;
    if (v.length > consumed.length && v.slice(0, consumed.length) === consumed) {
      typeChars(v.slice(consumed.length));
    }
    consumed = v;
    if (!composing && (v.length > 40 || /\s$/.test(v))) {
      kbd.value = '';
      consumed = '';
    }
  });
  kbd.addEventListener('compositionstart', function () { composing = true; });
  kbd.addEventListener('compositionend', function () {
    composing = false;
    setTimeout(function () {
      if (!composing) { kbd.value = ''; consumed = ''; }
    }, 0);
  });
  kbd.addEventListener('focus', updateKeyboardHint);
  kbd.addEventListener('blur', updateKeyboardHint);

  document.addEventListener('keydown', function (e) {
    var key = e.key;

    if (picker.open) {
      if (key === 'ArrowUp') { picker.move(-1); e.preventDefault(); }
      else if (key === 'ArrowDown') { picker.move(1); e.preventDefault(); }
      else if (key === 'Enter' || key === ' ') { picker.start(picker.selected); e.preventDefault(); }
      else if (key === 'Escape') { picker.hide(); e.preventDefault(); }
      return;
    }

    if (current === titleScene) {
      if (key === ' ' || key === 'Enter') { e.preventDefault(); picker.show(); }
      return;
    }

    if (current === gameScene) {
      if (key === 'Escape') { e.preventDefault(); setScene(titleScene); return; }
      if (gameScene.done) {
        if (key === 'Enter') { e.preventDefault(); startGame(gameScene.story); }
        return;
      }
      if (e.isComposing || key === 'Unidentified' || key === 'Process') return;
      if (key.length === 1 && !e.metaKey && !(e.ctrlKey && !e.altKey)) {
        e.preventDefault();
        typeChars(key);
      }
    }
  });

  // ------------------------------------------------------------------ pointer / buttons

  function isControl(el) {
    return !!(el && el.closest && el.closest('button, li, #kbd'));
  }

  app.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // Title: tap or click anywhere opens the story picker
  app.addEventListener('click', function (e) {
    if (current === titleScene && !picker.open && !isControl(e.target)) picker.show();
  });

  // Race: tapping anywhere brings the (phone) keyboard back
  app.addEventListener('pointerdown', function (e) {
    if (!wantsKeyboard() || isControl(e.target)) return;
    if (e.pointerType === 'mouse') e.preventDefault();
    focusKeyboard();
  });
  app.addEventListener('touchend', function (e) {
    if (!wantsKeyboard() || isControl(e.target)) return;
    e.preventDefault();
    focusKeyboard();
  }, { passive: false });

  $('start-btn').addEventListener('click', function () { picker.show(); });
  $('picker-back').addEventListener('click', function () { picker.hide(); });
  $('picker').addEventListener('click', function (e) { if (e.target === this) picker.hide(); });
  $('menu-btn').addEventListener('click', function () { setScene(titleScene); });
  $('again-btn').addEventListener('click', function () { startGame(gameScene.story); });
  $('stories-btn').addEventListener('click', function () { picker.show(); });

  function startGame(story) {
    setScene(gameScene, story);
  }

  // ------------------------------------------------------------------ main loop

  function render() {
    if (!current || !images.m) return;
    var k = view.s * view.dpr;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = false;
    current.render();
  }

  var last = 0;
  var acc = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    if (!last) last = now;
    var dt = now - last;
    last = now;
    if (dt > 250) dt = STEP; // tab was in the background: resume, don't fast-forward
    acc += dt;
    var n = 0;
    while (acc >= STEP && n < 5) {
      current.update();
      acc -= STEP;
      n++;
    }
    if (n === 5) acc = 0;
    render();
  }

  document.addEventListener('visibilitychange', function () {
    // requestAnimationFrame stops while hidden, which pauses the race; just reset the clock
    last = 0;
    acc = 0;
  });

  var relayoutQueued = false;
  function queueLayout() {
    if (relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(function () {
      relayoutQueued = false;
      layout();
    });
  }

  window.addEventListener('resize', queueLayout);
  window.addEventListener('orientationchange', queueLayout);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', queueLayout);
    window.visualViewport.addEventListener('scroll', queueLayout);
  }
  // keep the page itself from scrolling when the phone keyboard opens
  window.addEventListener('scroll', function () {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  });

  measureCharRatio();
  layout();
  loadImages(['m', 'c', 'd', 'g', 'a']).then(function () {
    setScene(titleScene);
    layout();
    requestAnimationFrame(frame);
  });

  // small hook for automated screenshots/tests
  window.typingRace = {
    scene: function () { return current && current.name; },
    game: gameScene,
    picker: picker,
    type: typeChars
  };
})();
