const re = /(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/;
const m = "2026-07-27".match(re);
console.log(m.groups.year + "/" + m.groups.month + "/" + m.groups.day);
console.log("2026-07-27".replace(re, "$<day>.$<month>.$<year>"));
