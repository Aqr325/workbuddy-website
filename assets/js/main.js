/* WorkBuddy 官网 — interactions
   - mobile nav toggle
   - scroll-triggered reveal (IntersectionObserver)
   - hero instrument panel gentle float
*/
(function () {
  "use strict";

  // ---- mobile nav ----
  var nav = document.querySelector(".nav");
  var toggle = document.getElementById("navToggle");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.querySelectorAll(".nav-links a").forEach(function (a) {
      a.addEventListener("click", function () {
        nav.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  // ---- scroll reveal ----
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add("in-view");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in-view"); });
  }

  // ---- hero panel gentle float ----
  var panel = document.querySelector(".panel");
  if (panel && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var t0 = performance.now();
    (function loop(now) {
      var t = (now - t0) / 1000;
      var y = Math.sin(t * 0.6) * 6;
      panel.style.transform =
        "perspective(1400px) rotateY(-7deg) rotateX(2deg) translateY(" + y.toFixed(2) + "px)";
      requestAnimationFrame(loop);
    })(t0);
  }
})();
