---
title: Podcast notes
description: Moments worth going back to
redirect_from:
- /podcasts/
---

[<a href="../../">Home</a>]

{% assign episodes = site.data.podcasts | sort %}
<ul>
{% for pair in episodes %}{% assign ep = pair[1] %}
  <li><a href="{{ pair[0] }}">{{ ep.title }}</a> — {{ ep.show }} ({{ ep.clips | size }} notes)</li>
{% endfor %}
</ul>
