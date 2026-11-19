(module
 (type $E (struct (field anyref) (field (mut anyref)) (field (mut i32)) (field (mut i32)) (field (mut anyref)) (field (mut anyref))))
 (type $M (array (mut (ref null $E))))
 (rec (type $P (struct (field (mut (ref null $P))) (field (mut (ref $M))) (field (mut i32)) (field (mut i32)) (field (mut i32)) (field (mut i32)))))
 (rec (type $O (struct (field (mut (ref null $O))) (field (mut (ref null $M))) (field (mut i32)) (field (mut i32)) (field (mut i32)) (field (mut i32)) (field (mut anyref)))))
 (func (export "isPrepared") (param externref) (result i32) (ref.test (ref $P) (any.convert_extern (local.get 0))))
 (func (export "isLegacy") (param externref) (result i32) (ref.test (ref $O) (any.convert_extern (local.get 0)))))
